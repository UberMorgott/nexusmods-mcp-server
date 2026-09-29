// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

// The user's default web browser (Windows only) and opening a URL in it.

import { execFile, spawn } from "node:child_process";

export interface DefaultBrowser {
  progId: string;
  /** Browser id as used by CookieExtractor (chrome, edge, firefox, …); null = unknown ProgId. */
  browser: string | null;
}

const USER_CHOICE = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";

/** https handler ProgId → browser id. */
export function browserFromProgId(progId: string): string | null {
  const p = progId.trim();
  if (/^ChromeHTML/i.test(p)) return "chrome";
  if (/^MSEdgeHTM/i.test(p)) return "edge";
  if (/^FirefoxURL/i.test(p)) return "firefox";
  if (/^BraveHTML/i.test(p)) return "brave";
  if (/^OperaGX/i.test(p)) return "opera-gx";
  if (/^Opera/i.test(p)) return "opera";
  if (/^VivaldiHTM/i.test(p)) return "vivaldi";
  if (/^YandexHTML/i.test(p)) return "yandex";
  if (/^CentHTM/i.test(p)) return "centbrowser";
  return null;
}

/** Default browser from the https UserChoice ProgId; null off Windows or when unset. */
export function detectDefaultBrowser(): Promise<DefaultBrowser | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("reg", ["query", USER_CHOICE, "/v", "ProgId"], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      const m = err ? null : /ProgId\s+REG_SZ\s+(\S+)/i.exec(stdout);
      resolve(m ? { progId: m[1], browser: browserFromProgId(m[1]) } : null);
    });
  });
}

/** Open `url` in the default browser (Windows shell handler). */
export function openInDefaultBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
