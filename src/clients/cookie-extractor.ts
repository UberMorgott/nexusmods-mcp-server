// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { CookieObject } from "@rookie-rs/api";
import type { CookieEntry } from "../utils/types.js";

export interface ExtractionResult {
  /** Browser id (lowercase: chrome, firefox, edge, …) or "none". */
  browser: string;
  cookies: CookieEntry[];
  /** Set when the store could not be read (not installed, locked, app-bound encryption …). */
  error?: string;
}

const NEXUS_DOMAINS = [".nexusmods.com", "nexusmods.com"];

type Rookie = typeof import("@rookie-rs/api");
type Reader = (r: Rookie, domains: string[]) => CookieObject[];

/** Browser id → reader. Order = silent-extraction order. */
const READERS: Array<[string, Reader]> = [
  ["chrome", (r, d) => r.chrome(d)],
  ["firefox", (r, d) => r.firefox(d)],
  ["edge", (r, d) => r.edge(d)],
  ["brave", (r, d) => r.brave(d)],
  ["chromium", (r, d) => r.chromium(d)],
  ["opera", (r, d) => r.opera(d)],
  ["opera-gx", (r, d) => r.operaGx(d)],
  ["vivaldi", (r, d) => r.vivaldi(d)],
  ["centbrowser", (r, d) => readChromiumProfiles(r, centUserDataDirs(), d)],
  ["arc", (r, d) => r.arc(d)],
  ["librewolf", (r, d) => r.librewolf(d)],
];

/** Cent Browser (Chromium fork) user-data dirs: the installer location, plus
 *  "<exe dir>\User Data" of the registered https handler (portable installs). */
export function centUserDataDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "CentBrowser", "User Data"));
  if (process.platform === "win32") {
    try {
      const keys = execFileSync("reg", ["query", "HKCU\\Software\\Classes", "/f", "CentHTM", "/k"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      const key = /^(HKEY_CURRENT_USER\\Software\\Classes\\CentHTM\S*)/im.exec(keys)?.[1];
      if (key) {
        const cmd = execFileSync("reg", ["query", `${key}\\shell\\open\\command`, "/ve"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
        const exe = /REG_SZ\s+"([^"]+)"/i.exec(cmd)?.[1];
        if (exe) dirs.push(path.join(path.dirname(exe), "User Data"));
      }
    } catch {
      // not registered
    }
  }
  return [...new Set(dirs)].filter((d) => existsSync(path.join(d, "Local State")));
}

/** Chromium user-data dirs per browser (Opera keeps the profile itself there). */
function chromiumDirs(browser: string): string[] | null {
  const local = process.env.LOCALAPPDATA || "";
  const roaming = process.env.APPDATA || "";
  switch (browser) {
    case "chrome": return [path.join(local, "Google", "Chrome", "User Data")];
    case "edge": return [path.join(local, "Microsoft", "Edge", "User Data")];
    case "brave": return [path.join(local, "BraveSoftware", "Brave-Browser", "User Data")];
    case "chromium": return [path.join(local, "Chromium", "User Data")];
    case "vivaldi": return [path.join(local, "Vivaldi", "User Data")];
    case "opera": return [path.join(roaming, "Opera Software", "Opera Stable")];
    case "opera-gx": return [path.join(roaming, "Opera Software", "Opera GX Stable")];
    case "centbrowser": return centUserDataDirs();
    default: return null;
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Cookie DB files (+ -wal / -journal) of a browser; null when its layout is unknown. */
export function cookieStoreFiles(browser: string): string[] | null {
  const bases: string[] = [];
  if (browser === "firefox" || browser === "librewolf") {
    const root = browser === "firefox"
      ? path.join(process.env.APPDATA || "", "Mozilla", "Firefox", "Profiles")
      : path.join(process.env.APPDATA || "", "librewolf", "Profiles");
    for (const p of listDirs(root)) bases.push(path.join(root, p, "cookies.sqlite"));
  } else {
    const dirs = chromiumDirs(browser);
    if (!dirs) return null;
    for (const dir of dirs) {
      const profiles = [".", ...listDirs(dir).filter((n) => n === "Default" || /^Profile \d+$/.test(n))];
      for (const p of profiles) bases.push(path.join(dir, p, "Network", "Cookies"), path.join(dir, p, "Cookies"));
    }
  }
  return bases.flatMap((b) => [b, `${b}-wal`, `${b}-journal`]).filter(existsSync);
}

/** mtime+size fingerprint of a browser's cookie store (fs.stat works on a locked file).
 *  null when the store location is unknown. */
export function cookieStoreSignature(browser: string): string | null {
  const files = cookieStoreFiles(browser);
  if (!files) return null;
  return files
    .map((f) => {
      try {
        const st = statSync(f);
        return `${f}:${st.mtimeMs}:${st.size}`;
      } catch {
        return `${f}:gone`;
      }
    })
    .sort()
    .join("|");
}

/** Chromium-layout store: every profile's (Network\)Cookies, decrypted with the Local State key.
 *  Returns the first profile that has cookies for the domains. */
function readChromiumProfiles(r: Rookie, userDataDirs: string[], domains: string[]): CookieObject[] {
  if (!userDataDirs.length) throw new Error("not installed");
  let lastErr: unknown = null;
  for (const dir of userDataDirs) {
    const profiles = readdirSync(dir).filter((n) => n === "Default" || /^Profile \d+$/.test(n));
    for (const p of profiles) {
      const db = [path.join(dir, p, "Network", "Cookies"), path.join(dir, p, "Cookies")].find(existsSync);
      if (!db) continue;
      try {
        const got = r.chromiumBased(path.join(dir, "Local State"), db, domains);
        if (got.length) return got;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

/** Reads nexusmods.com cookies out of locally installed browsers via @rookie-rs/api.
 *  The native module is loaded with dynamic import() so the server never crashes without it. */
export class CookieExtractor {
  private async rookie(): Promise<Rookie | null> {
    try {
      return await import("@rookie-rs/api");
    } catch {
      return null;
    }
  }

  /** First installed browser that has nexusmods.com cookies. */
  async extractCookies(): Promise<ExtractionResult> {
    const rookie = await this.rookie();
    if (!rookie)
      return { browser: "none", cookies: [], error: "@rookie-rs/api not available on this platform. Use web_login (interactive) or web_set_cookies." };
    for (const [name] of READERS) {
      const r = this.read(rookie, name);
      if (r.error) console.error(`[login] extract ${name}: error: ${r.error}`);
      else console.error(`[login] extract ${name}: ${r.cookies.length} cookies`);
      if (r.cookies.length > 0) return r;
    }
    return { browser: "none", cookies: [], error: "No browser had nexusmods.com cookies" };
  }

  /** nexusmods.com cookies from one browser; `error` when its store can't be read. */
  async extractFrom(browser: string): Promise<ExtractionResult> {
    const rookie = await this.rookie();
    if (!rookie) return { browser, cookies: [], error: "@rookie-rs/api not available on this platform" };
    return this.read(rookie, browser);
  }

  private read(rookie: Rookie, browser: string): ExtractionResult {
    const reader = READERS.find(([n]) => n === browser)?.[1];
    if (!reader) return { browser, cookies: [], error: `no cookie reader for ${browser}` };
    try {
      const raw = reader(rookie, NEXUS_DOMAINS);
      // rookie swallows per-cookie decrypt failures and returns empty values
      // (e.g. a cookie encryption format it doesn't know) — the store is not usable.
      if (raw.length > 0 && raw.every((c) => !c.value))
        return { browser, cookies: [], error: `cookie values could not be decrypted (${raw.length} cookies, all empty)` };
      return { browser, cookies: raw.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })) };
    } catch (e) {
      return { browser, cookies: [], error: errText(e) };
    }
  }
}
