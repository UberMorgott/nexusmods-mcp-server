// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

import type { CookieObject } from "@rookie-rs/api";
import type { CookieEntry } from "../utils/types.js";

export interface ExtractionResult {
  browser: string;
  cookies: CookieEntry[];
  error?: string;
}

const NEXUS_DOMAINS = [".nexusmods.com", "nexusmods.com"];

type BrowserFn = (domains?: string[] | null) => CookieObject[];

/** Reads nexusmods.com cookies out of locally installed browsers via @rookie-rs/api.
 *  The native module is loaded with dynamic import() so the server never crashes without it. */
export class CookieExtractor {
  async extractCookies(): Promise<ExtractionResult> {
    let rookie: typeof import("@rookie-rs/api");
    try {
      rookie = await import("@rookie-rs/api");
    } catch {
      return {
        browser: "none",
        cookies: [],
        error: "@rookie-rs/api not available on this platform. Use web_login (interactive) or web_set_cookies.",
      };
    }

    const browsers: Array<[string, BrowserFn]> = [
      ["Chrome", rookie.chrome],
      ["Firefox", rookie.firefox],
      ["Edge", rookie.edge],
      ["Brave", rookie.brave],
      ["Chromium", rookie.chromium],
      ["Opera", rookie.opera],
      ["Opera GX", rookie.operaGx],
      ["Vivaldi", rookie.vivaldi],
      ["Arc", rookie.arc],
      ["LibreWolf", rookie.librewolf],
    ];

    for (const [name, fn] of browsers) {
      try {
        const raw = fn(NEXUS_DOMAINS);
        if (raw.length > 0) {
          const cookies = raw.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
          console.error(`[cookie-extractor] ${cookies.length} cookies from ${name}`);
          return { browser: name, cookies };
        }
      } catch {
        // browser not installed or inaccessible — skip
      }
    }
    return { browser: "none", cookies: [], error: "No browser had nexusmods.com cookies" };
  }
}
