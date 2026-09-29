// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

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

type BrowserFn = (domains?: string[] | null) => CookieObject[];
type Rookie = typeof import("@rookie-rs/api");

/** Browser id → reader. Order = silent-extraction order. */
const READERS: Array<[string, (r: Rookie) => BrowserFn]> = [
  ["chrome", (r) => r.chrome],
  ["firefox", (r) => r.firefox],
  ["edge", (r) => r.edge],
  ["brave", (r) => r.brave],
  ["chromium", (r) => r.chromium],
  ["opera", (r) => r.opera],
  ["opera-gx", (r) => r.operaGx],
  ["vivaldi", (r) => r.vivaldi],
  ["arc", (r) => r.arc],
  ["librewolf", (r) => r.librewolf],
];

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
      const raw = reader(rookie)(NEXUS_DOMAINS);
      return { browser, cookies: raw.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })) };
    } catch (e) {
      return { browser, cookies: [], error: errText(e) };
    }
  }
}
