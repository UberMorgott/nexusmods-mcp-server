// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { CookieEntry } from "../utils/types.js";
import { CookieExtractor } from "./cookie-extractor.js";
import { BrowserClient, FORUMS_ORIGIN, WWW_ORIGIN } from "./browser-client.js";
import { fetchAndParse, submitRequest, type ParseKind, type SubmitArgs } from "./site-parsers.js";

function originOf(url: string): string {
  return new URL(url).hostname === "forums.nexusmods.com" ? FORUMS_ORIGIN : WWW_ORIGIN;
}

/** GraphQL router the nexusmods.com front-end calls with the session cookie
 *  (window.env.NEXT_PUBLIC_API_PUBLIC_GRAPHQL_URI). */
const API_ROUTER = "https://api-router.nexusmods.com/graphql";
const LOGIN_URL = "https://users.nexusmods.com/auth/sign_in?redirect_url=https%3A%2F%2Fwww.nexusmods.com%2F";
/** Sign-in window poll: 2FA / Google sign-in can take several minutes. */
export const LOGIN_TIMEOUT_MS = 600_000;

export interface Account {
  memberId: number;
  name: string;
}

/** Where the stored session came from: extracted from an installed browser, captured
 *  from the visible sign-in window, or pasted via web_set_cookies. null = unknown. */
export type SessionSource = "browser" | "window" | "manual";

/** Sidecar next to the cookies file (`session.json`); survives restarts. */
interface SessionMeta {
  source: SessionSource | null;
  browser: string | null;
  /** web_logout ran: no silent browser extraction at startup until the next explicit login. */
  signedOut: boolean;
}

export interface LoginOutcome {
  loggedIn: boolean;
  /** This call opened a visible sign-in window. */
  loginWindowOpened: boolean;
  detail: string;
}

/** `preferences.id` is a base64 global id "gid://api/MembersPreference/<memberId>" —
 *  the only "current user" handle the api-router exposes (no viewer/me query). The forum
 *  (Invision) member id is a different number and must not be used here. */
export function memberIdFromGid(id: unknown): number | null {
  if (typeof id !== "string" || !id) return null;
  const raw = id.startsWith("gid://") ? id : Buffer.from(id, "base64").toString("utf8");
  const m = /^gid:\/\/[^/]+\/[^/]+\/(\d+)$/.exec(raw);
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export class WebClient {
  private cookies: CookieEntry[] = [];
  private browser = new BrowserClient();
  private loginPolling = false;
  /** Bumped by logout: a running sign-in poll with an older value stops. */
  private loginGen = 0;
  private meta: SessionMeta = { source: null, browser: null, signedOut: false };
  /** Logged-in account, cached until the cookies change. */
  private account: Account | null = null;
  /** Silent browser-cookie extraction (replaced in tests). */
  protected extractCookies = () => new CookieExtractor().extractCookies();

  constructor(private config: Config) {
    this.loadCookies();
    this.loadMeta();
  }

  private get metaPath(): string {
    return path.join(path.dirname(this.config.cookiesPath), "session.json");
  }

  /** Non-blocking startup: push on-disk cookies to the browser and, if none, try a SILENT
   *  cookie extraction in the background. Never opens a login window here. */
  init(): void {
    this.browser.setCookies(this.cookies);
    if (this.meta.signedOut) this.browser.markClearOnLaunch();
    else if (!this.hasCookies()) void this.backgroundExtract();
  }

  hasCookies(): boolean {
    return this.cookies.length > 0;
  }

  /** True while a visible sign-in window from web_login is open and being polled. */
  loginInProgress(): boolean {
    return this.loginPolling;
  }

  private async backgroundExtract(): Promise<void> {
    try {
      const result = await this.extractCookies();
      if (result.cookies.length > 0 && !this.meta.signedOut && !this.hasCookies()) {
        this.applyCookies(result.cookies, "browser", result.browser);
        console.error(`[web-client] Extracted ${result.cookies.length} cookies from ${result.browser}`);
      }
    } catch (e) {
      console.error(`[web-client] Background cookie extraction failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private loadCookies(): void {
    if (!existsSync(this.config.cookiesPath)) return;
    try {
      this.cookies = JSON.parse(readFileSync(this.config.cookiesPath, "utf-8"));
    } catch {
      this.cookies = [];
    }
  }

  private saveCookies(): void {
    mkdirSync(path.dirname(this.config.cookiesPath), { recursive: true });
    writeFileSync(this.config.cookiesPath, JSON.stringify(this.cookies, null, 2));
  }

  private loadMeta(): void {
    try {
      const m = JSON.parse(readFileSync(this.metaPath, "utf-8"));
      const source = ["browser", "window", "manual"].includes(m?.source) ? (m.source as SessionSource) : null;
      this.meta = { source, browser: typeof m?.browser === "string" ? m.browser : null, signedOut: m?.signedOut === true };
    } catch {
      // no sidecar (legacy cookies file / fresh install) → source unknown
    }
  }

  private saveMeta(): void {
    mkdirSync(path.dirname(this.metaPath), { recursive: true });
    writeFileSync(this.metaPath, JSON.stringify(this.meta, null, 2));
  }

  private applyCookies(cookies: CookieEntry[], source: SessionSource, browser: string | null = null): void {
    this.cookies = cookies;
    this.account = null;
    this.browser.setCookies(cookies);
    this.saveCookies();
    this.meta = { source, browser: source === "browser" ? browser || null : null, signedOut: false };
    this.saveMeta();
  }

  /** Where the stored session came from (null when unknown or no session). */
  sessionSource(): { sessionSource: SessionSource | null; sessionBrowser: string | null } {
    if (!this.hasCookies()) return { sessionSource: null, sessionBrowser: null };
    return { sessionSource: this.meta.source, sessionBrowser: this.meta.browser };
  }

  /** web_logout: stop a running sign-in, forget the session everywhere (memory, cookies
   *  file, live browser profile, account cache) and stay signed out across restarts —
   *  no silent browser extraction until the next web_login / web_set_cookies. */
  async logout(): Promise<{ loggedOut: true; cookiesStored: false }> {
    this.loginGen++;
    this.loginPolling = false;
    this.cookies = [];
    this.account = null;
    rmSync(this.config.cookiesPath, { force: true });
    this.meta = { source: null, browser: null, signedOut: true };
    this.saveMeta();
    await this.browser.clearSiteCookies();
    await this.browser.close(); // closes the sign-in window too
    return { loggedOut: true, cookiesStored: false };
  }

  /** "name=value; name2=value2" (a browser Cookie header) → cookies on .nexusmods.com. */
  setCookiesFromString(cookieString: string): number {
    const entries = cookieString
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const eq = c.indexOf("=");
        if (eq === -1) return null;
        return { name: c.slice(0, eq).trim(), value: c.slice(eq + 1).trim(), domain: ".nexusmods.com", path: "/" };
      })
      .filter((c): c is CookieEntry => c !== null);
    this.applyCookies(entries, "manual");
    return entries.length;
  }

  /** Session check exactly as the site does it: the api-router answers `preferences`
   *  only for a logged-in session (UNAUTHORIZED otherwise). */
  async whoAmI(): Promise<{ loggedIn: boolean; detail: string }> {
    const res = await this.browser.fetch(API_ROUTER, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GraphQL-OperationName": "Preferences" },
      body: JSON.stringify({ operationName: "Preferences", query: "query Preferences { preferences { __typename } }" }),
    });
    let json: any = null;
    try {
      json = JSON.parse(res.body);
    } catch {
      return { loggedIn: false, detail: `HTTP ${res.status}` };
    }
    if (json?.data?.preferences) return { loggedIn: true, detail: "session valid" };
    return { loggedIn: false, detail: json?.errors?.[0]?.message || `HTTP ${res.status}` };
  }

  /** The logged-in account (member id + name), cached until the cookies change.
   *  Throws when not logged in or the lookup fails. */
  async getAccount(): Promise<Account> {
    if (this.account) return this.account;
    const cookies = this.cookies;
    const p = await this.sessionGraphql<{ preferences: { id: string } | null }>(
      "Preferences",
      "query Preferences { preferences { id } }",
      {},
    );
    const memberId = memberIdFromGid(p?.preferences?.id);
    if (!memberId) throw new Error("account id not found in preferences");
    const u = await this.sessionGraphql<{ user: { memberId: number; name: string } | null }>(
      "UserName",
      "query UserName($id: Int!) { user(id: $id) { memberId name } }",
      { id: memberId },
    );
    if (!u?.user?.name) throw new Error(`no user ${memberId}`);
    const account = { memberId: Number(u.user.memberId) || memberId, name: u.user.name };
    if (this.cookies === cookies) this.account = account; // cookies swapped mid-lookup → don't cache
    return account;
  }

  /** web_status json: session check plus the account identity when logged in. */
  async statusJson(): Promise<Record<string, unknown>> {
    const who = await this.whoAmI();
    const out: Record<string, unknown> = {
      loggedIn: who.loggedIn,
      loginInProgress: this.loginInProgress(),
      cookiesStored: this.hasCookies(),
      detail: who.detail,
      account: null,
      ...this.sessionSource(),
    };
    if (who.loggedIn) {
      try {
        out.account = await this.getAccount();
      } catch (e) {
        out.accountError = e instanceof Error ? e.message : String(e);
      }
    }
    return out;
  }

  async autoExtractCookies(): Promise<string> {
    return (await this.login()).detail;
  }

  /** Silent extraction from installed browsers first; else a visible sign-in window. */
  async login(): Promise<LoginOutcome> {
    const result = await this.extractCookies();
    if (result.cookies.length > 0) {
      this.applyCookies(result.cookies, "browser", result.browser);
      const who = await this.whoAmI().catch(() => ({ loggedIn: false, detail: "check failed" }));
      if (who.loggedIn)
        return { loggedIn: true, loginWindowOpened: false, detail: `Extracted ${result.cookies.length} cookies from ${result.browser}; logged in.` };
    }
    // Nothing usable (e.g. Chrome 127+ App-Bound Encryption) → interactive login.
    return await this.browserLogin();
  }

  /** Opens the Nexus sign-in page VISIBLY and returns immediately; a background poll
   *  captures the session once the user signs in (persistent profile keeps it). */
  private async browserLogin(): Promise<LoginOutcome> {
    const no = (detail: string): LoginOutcome => ({ loggedIn: false, loginWindowOpened: false, detail });
    if (this.loginPolling) return no("A login window is already open — finish signing in there; the session is captured automatically.");
    try {
      await this.browser.openLoginPage(LOGIN_URL);
    } catch (e) {
      return no(`Could not open the login browser: ${e instanceof Error ? e.message : e} (run: npx patchright install chromium)`);
    }
    this.loginPolling = true;
    const gen = this.loginGen;
    void this.pollForLogin(LOGIN_TIMEOUT_MS).finally(() => {
      if (gen !== this.loginGen) return; // logout already stopped it and closed the window
      this.loginPolling = false;
      void this.browser.close();
    });
    return {
      loggedIn: false,
      loginWindowOpened: true,
      detail:
        "A Nexus Mods login window has opened. Sign in there — the session is captured automatically " +
        "and persists for future runs; then re-run your action. Alternative: web_set_cookies with the " +
        "Cookie header from a browser where you're logged in to nexusmods.com.",
    };
  }

  private async pollForLogin(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    const gen = this.loginGen;
    try {
      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 3000));
        if (gen !== this.loginGen) return false; // web_logout
        const who = await this.whoAmI().catch(() => ({ loggedIn: false }));
        if (gen !== this.loginGen) return false;
        if (who.loggedIn) {
          const cookies = await this.browser.getCookies();
          if (gen !== this.loginGen) return false;
          this.applyCookies(cookies, "window");
          console.error(`[web-client] Login detected — ${cookies.length} cookies saved.`);
          return true;
        }
      }
      console.error("[web-client] Login wait timed out.");
    } catch (e) {
      console.error(`[web-client] Login window lost: ${e instanceof Error ? e.message : e}`);
    }
    return false;
  }

  /** Blocking interactive login for the setup wizard (NOT for MCP requests). */
  async loginInteractive(timeoutMs = 180_000): Promise<boolean> {
    await this.browser.openLoginPage(LOGIN_URL);
    try {
      return await this.pollForLogin(timeoutMs);
    } finally {
      await this.browser.close();
    }
  }

  // ── Site operations ────────────────────────────────────────────

  async parse(kind: ParseKind, url: string, form?: Record<string, string>): Promise<any> {
    const out = await this.browser.evaluate(originOf(url), fetchAndParse, { kind, url, form });
    if (out?.error) throw new Error(out.error);
    return out;
  }

  /** Send a request from inside the site page (form, multipart upload or JSON), as the
   *  site's own scripts do. Never throws on HTTP status. */
  async submit(args: SubmitArgs): Promise<{ status: number; url: string; contentType: string; body: string }> {
    return this.browser.evaluate(originOf(args.url), submitRequest, args);
  }

  /** Run a self-contained function inside the page of `origin`. */
  async evaluate<A, R>(origin: string, fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
    return this.browser.evaluate(origin, fn, arg);
  }

  /** The forums (Invision) keep their own session. A nexusmods.com login carries over via
   *  the site's SSO: opening forums /login/ with a valid session signs in silently, exactly
   *  like clicking "Sign In" on the forums. Returns the member id and csrfKey. */
  async ensureForumSession(): Promise<{ memberId: number; csrfKey: string }> {
    let s = await this.parse("forumSession", `${FORUMS_ORIGIN}/`);
    if (!s.memberId) {
      if (!this.hasCookies()) throw new Error("Not logged in. Run web_login first.");
      await this.browser.navigate(FORUMS_ORIGIN, `${FORUMS_ORIGIN}/login/`);
      s = await this.parse("forumSession", `${FORUMS_ORIGIN}/`);
      if (!s.memberId) throw new Error("Forum sign-in (SSO) failed — nexusmods.com session expired? Run web_login.");
    }
    return { memberId: s.memberId, csrfKey: s.csrfKey || "" };
  }

  /** POST/PUT a jQuery-style form to www.nexusmods.com (same-origin XHR, as the site does). */
  async postForm(pathname: string, method: "POST" | "PUT", fields: Record<string, string | number>): Promise<{ status: number; body: string; contentType: string }> {
    const body = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])).toString();
    return this.browser.fetch(`${WWW_ORIGIN}${pathname}`, {
      method,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "*/*",
      },
      body,
    });
  }

  /** GraphQL through the api-router with the browser session, mirroring the site's
   *  client (credentials: include + X-GraphQL-OperationName header). */
  async sessionGraphql<T = any>(operationName: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.browser.fetch(API_ROUTER, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GraphQL-OperationName": operationName },
      body: JSON.stringify({ operationName, query, variables }),
    });
    let json: any;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new Error(`HTTP ${res.status} from api-router: ${res.body.slice(0, 300)}`);
    }
    if (json.errors?.length) {
      const msg = json.errors.map((e: any) => e.message).join("; ");
      const unauth = json.errors.some((e: any) => e.extensions?.code === "UNAUTHORIZED");
      throw new Error(unauth ? `Not logged in (${msg}). Run web_login.` : msg);
    }
    return json.data as T;
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
