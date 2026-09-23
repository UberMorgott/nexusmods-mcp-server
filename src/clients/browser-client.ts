// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

import os from "node:os";
import path from "node:path";
import { closeSync, mkdirSync, openSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import type { BrowserContext, Page } from "patchright";
import type { CookieEntry } from "../utils/types.js";
import { detectChromeExecutable } from "../utils/helpers.js";

export interface FetchResult {
  status: number;
  contentType: string;
  body: string;
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

// 5 min idle window — long enough to avoid a costly Cloudflare re-challenge between
// successive requests, short enough to eventually free Chrome when idle.
const IDLE_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 45_000;
const CF_WAIT_MS = 45_000;

export const WWW_ORIGIN = "https://www.nexusmods.com";
export const FORUMS_ORIGIN = "https://forums.nexusmods.com";

/** Which site page a request runs from. fetch() executes inside that page, so it carries
 *  the page's cookies and passes Cloudflare. Cross-origin calls (e.g. api-router GraphQL)
 *  run from the www page, exactly as the site's own front-end does. */
function originFor(url: string): string {
  return new URL(url).hostname === "forums.nexusmods.com" ? FORUMS_ORIGIN : WWW_ORIGIN;
}

export class BrowserClient {
  /** Whether the current context was launched headed (interactive login). */
  private visible = false;
  private context: BrowserContext | null = null;
  private pages = new Map<string, Page>();
  private cookies: CookieEntry[] = [];
  private initPromise: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-process profile in use (shared one was locked); deleted on close. */
  private tempProfileDir: string | null = null;

  setCookies(cookies: CookieEntry[]): void {
    this.cookies = cookies;
    this.context?.addCookies(cookies.map(toPlaywrightCookie)).catch(() => {});
  }

  /** Run fetch() inside the site page for the URL's origin. Retries once after a
   *  Cloudflare challenge re-navigation. Never throws on HTTP status — callers decide. */
  async fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
    this.clearIdleTimer();
    try {
      const origin = originFor(url);
      const page = await this.pageFor(origin);
      let result = await this.evaluateFetch(page, url, opts);
      if (result.status === 403 && isCloudflareBlock(result.body)) {
        console.error("[browser-client] Cloudflare block, re-navigating to pass challenge");
        await this.navigateAndWaitForCf(page, origin + "/");
        result = await this.evaluateFetch(page, url, opts);
      }
      return result;
    } finally {
      this.resetIdleTimer();
    }
  }

  /** Evaluate a self-contained function inside the site page for `origin`
   *  (used to parse HTML with the browser's DOMParser). */
  async evaluate<A, R>(origin: string, fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
    this.clearIdleTimer();
    try {
      const page = await this.pageFor(origin);
      return await withTimeout(page.evaluate(fn as any, arg) as Promise<R>, REQUEST_TIMEOUT_MS, `evaluate on ${origin}`);
    } finally {
      this.resetIdleTimer();
    }
  }

  /** Live nexusmods.com cookies from the dedicated browser context. */
  async getCookies(): Promise<CookieEntry[]> {
    await this.ensureInit();
    if (!this.context) return [];
    const all = await this.context.cookies();
    return all
      .filter((c) => c.domain.includes("nexusmods.com"))
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
  }

  /** Open the login URL in a VISIBLE window. The hidden context is closed first — both
   *  use the same profile, which only one Chrome process can hold at a time. */
  async openLoginPage(url: string): Promise<void> {
    if (this.initPromise && !this.visible) await this.close();
    await this.ensureInit(true);
    const page = await this.pageFor(WWW_ORIGIN);
    await this.navigateAndWaitForCf(page, url);
  }

  async close(): Promise<void> {
    this.clearIdleTimer();
    const pending = this.initPromise;
    this.initPromise = null;
    if (pending) await pending.catch(() => {});
    const ctx = this.context;
    this.context = null;
    this.pages.clear();
    // A persistent context has no separate Browser object, so close the context itself.
    if (ctx) {
      console.error("[browser-client] Closing Chrome");
      await ctx.close().catch(() => {});
    }
    this.removeTempProfile();
  }

  private removeTempProfile(): void {
    const dir = this.tempProfileDir;
    this.tempProfileDir = null;
    if (dir) removeDir(dir);
  }

  private async pageFor(origin: string): Promise<Page> {
    await this.ensureInit();
    const existing = this.pages.get(origin);
    if (existing && !existing.isClosed()) return existing;
    if (!this.context) throw new Error("Browser context not initialized");
    const unused = this.context.pages().find((p) => p.url() === "about:blank" && ![...this.pages.values()].includes(p));
    const page = unused ?? (await this.context.newPage());
    // `npm run dev` (tsx/esbuild keepNames) wraps named functions in __name(); define a
    // no-op in the page so functions passed to page.evaluate() still run there.
    await page.addInitScript("globalThis.__name = globalThis.__name || ((f) => f);");
    await this.preparePage(page);
    console.error(`[browser-client] Navigating to ${origin}...`);
    await this.navigateAndWaitForCf(page, origin + "/");
    this.pages.set(origin, page);
    return page;
  }

  private async evaluateFetch(page: Page, url: string, opts: FetchOptions): Promise<FetchResult> {
    const run = page.evaluate(
      async ({ reqUrl, o }: { reqUrl: string; o: FetchOptions }) => {
        const r = await fetch(reqUrl, {
          method: o.method || "GET",
          headers: o.headers,
          body: o.body,
          credentials: "include",
        });
        return { status: r.status, contentType: r.headers.get("content-type") || "", body: await r.text() };
      },
      { reqUrl: url, o: opts },
    );
    return withTimeout(run, REQUEST_TIMEOUT_MS, url);
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      console.error("[browser-client] Idle timeout, closing Chrome");
      void this.close();
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Reuse whatever context is open; otherwise launch one. `visible` only matters on launch. */
  private async ensureInit(visible = false): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.visible = visible || process.env.NEXUS_BROWSER_VISIBLE === "1";
    const p = this.init(this.visible);
    this.initPromise = p;
    p.catch(() => {
      if (this.initPromise === p) this.initPromise = null;
    });
    return p;
  }

  private async init(visible: boolean): Promise<void> {
    let chromium: any;
    try {
      const mod: any = await import("patchright");
      chromium = mod.chromium || mod.default?.chromium;
    } catch {
      throw new Error(
        "patchright is required for web-tier tools (mod comments, forums, collection comment writes).\n" +
          "Install: npm install patchright\n" +
          "Then install the bundled browser: npx patchright install chromium",
      );
    }

    // Dedicated profile, isolated from the user's own browser: the shared persistent one,
    // or a per-process one if another server process holds it.
    const userDataDir = pickProfileDir();
    this.tempProfileDir = userDataDir === SHARED_PROFILE_DIR ? null : userDataDir;

    // Normal requests run fully headless (new headless mode, no window). Cloudflare rejects
    // headless only by its "HeadlessChrome" UA token, so preparePage() overrides the UA per page.
    // Interactive login (visible=true) runs headed so the user can sign in.
    let context: BrowserContext;
    try {
      context = await this.launchContext(chromium, userDataDir, visible);
    } catch (err) {
      this.removeTempProfile();
      // Lost a launch race for the shared profile to another server process.
      const msg = err instanceof Error ? err.message : String(err);
      if (userDataDir !== SHARED_PROFILE_DIR || !msg.includes("has been closed")) throw err;
      const dir = createTempProfileDir();
      console.error(`[browser-client] Shared profile busy, retrying with ${dir}`);
      this.tempProfileDir = dir;
      try {
        context = await this.launchContext(chromium, dir, visible);
      } catch (retryErr) {
        this.removeTempProfile();
        throw retryErr;
      }
    }
    this.context = context;
    try {
      if (this.cookies.length) await context.addCookies(this.cookies.map(toPlaywrightCookie));
    } catch (err) {
      this.context = null;
      await context.close().catch(() => {});
      this.removeTempProfile();
      throw err;
    }
    console.error(`[browser-client] Chrome ready (${visible ? "visible" : "headless"})`);
  }

  /** Headless Chrome advertises "HeadlessChrome" in its user agent, which Cloudflare
   *  blocks. Replace it with the real browser's plain UA (version kept exact). */
  private async preparePage(page: Page): Promise<void> {
    if (this.visible) return;
    const cdp = await page.context().newCDPSession(page);
    const { userAgent } = await cdp.send("Browser.getVersion");
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: userAgent.replace("HeadlessChrome", "Chrome"),
    });
  }

  // Prefer patchright's bundled Chromium; fall back to system Chrome. Both share the same
  // dedicated userDataDir for session persistence.
  private async launchContext(chromium: any, userDataDir: string, visible: boolean): Promise<BrowserContext> {
    const needsNoSandbox =
      process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0;
    const launchOpts = {
      headless: !visible,
      args: ["--lang=en-US", ...(needsNoSandbox ? ["--no-sandbox"] : [])],
      viewport: null,
    };

    // channel "chromium" = full browser in new headless mode (not chromium-headless-shell).
    try {
      console.error(`[browser-client] Launching bundled Chromium via patchright (headless=${launchOpts.headless})`);
      return await chromium.launchPersistentContext(userDataDir, { ...launchOpts, channel: "chromium" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const bundledMissing = msg.includes("Executable doesn't exist") || msg.includes("patchright install");
      if (!bundledMissing) throw err;
      console.error(`[browser-client] Bundled Chromium not installed, falling back to system Chrome (${msg.split("\n")[0]})`);
    }

    const chromePath = detectChromeExecutable();
    if (!chromePath) {
      throw new Error(
        "patchright's bundled Chromium is not installed and no system Chrome was found.\n" +
          "Run `npx patchright install chromium` to install the bundled browser.",
      );
    }
    console.error(`[browser-client] Launching system Chrome via patchright (headless=${launchOpts.headless}): ${chromePath}`);
    try {
      return await chromium.launchPersistentContext(userDataDir, { ...launchOpts, executablePath: chromePath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("has been closed")) {
        throw new Error(
          "Could not launch Chrome: your system Chrome appears to be already running (the new process " +
            "handed off to it and exited). Close Chrome and retry, or run `npx patchright install chromium` " +
            "to install the bundled browser, which coexists with your running Chrome.",
        );
      }
      throw err;
    }
  }

  private async navigateAndWaitForCf(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const start = Date.now();
    while (Date.now() - start < CF_WAIT_MS) {
      try {
        const title: string = await page.evaluate(() => document.title);
        if (!isCfTitle(title)) {
          console.error(`[browser-client] CF passed for ${new URL(url).hostname} (${Date.now() - start}ms)`);
          return;
        }
      } catch {
        // page navigating during CF resolution — wait
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    console.error(`[browser-client] Warning: CF challenge did not resolve for ${url} after ${CF_WAIT_MS}ms`);
  }
}

function isCfTitle(title: string): boolean {
  return title.includes("moment") || title.includes("момент");
}

function isCloudflareBlock(body: string): boolean {
  return /cf-chl|challenge-platform|Just a moment|cf_chl/i.test(body.slice(0, 5000));
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${what}`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

const PROFILE_ROOT = path.join(os.homedir(), ".nexusmods-mcp");
const SHARED_PROFILE_DIR = path.join(PROFILE_ROOT, "chrome-profile");
const TEMP_PROFILE_RE = /^chrome-profile-(\d+)$/;

/** Every MCP client session runs its own server process, but a Chrome profile can be
 *  held by one browser only. Use the shared profile when free; otherwise a per-process
 *  one. Auth does not depend on the profile: session cookies come from .auth/cookies.json
 *  (injected on launch) and a login saves them back there. */
function pickProfileDir(): string {
  mkdirSync(SHARED_PROFILE_DIR, { recursive: true });
  removeStaleTempProfiles();
  if (!profileInUse(SHARED_PROFILE_DIR)) return SHARED_PROFILE_DIR;
  const dir = createTempProfileDir();
  console.error(`[browser-client] Shared profile in use by another process, using ${dir}`);
  return dir;
}

function createTempProfileDir(): string {
  const dir = path.join(PROFILE_ROOT, `chrome-profile-${process.pid}`);
  removeDir(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Chrome holds `lockfile` open exclusively on Windows; elsewhere `SingletonLock` is a
 *  symlink to "<host>-<pid>". */
function profileInUse(dir: string): boolean {
  if (process.platform === "win32") {
    try {
      closeSync(openSync(path.join(dir, "lockfile"), "r+"));
      return false;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "EBUSY" || code === "EPERM";
    }
  }
  try {
    const pid = Number(/-(\d+)$/.exec(readlinkSync(path.join(dir, "SingletonLock")))?.[1]);
    return pid > 0 && pidAlive(pid);
  } catch {
    return false;
  }
}

/** Delete per-process profiles left behind by server processes that are gone. */
function removeStaleTempProfiles(): void {
  let names: string[];
  try {
    names = readdirSync(PROFILE_ROOT);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(TEMP_PROFILE_RE.exec(name)?.[1]);
    if (pid && pid !== process.pid && !pidAlive(pid)) removeDir(path.join(PROFILE_ROOT, name));
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.error(`[browser-client] Could not remove ${dir}: ${e instanceof Error ? e.message : e}`);
  }
}

function toPlaywrightCookie(c: CookieEntry): { name: string; value: string; domain: string; path: string } {
  return { name: c.name, value: c.value, domain: c.domain, path: c.path };
}
