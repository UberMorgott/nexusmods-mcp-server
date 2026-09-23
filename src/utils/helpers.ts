// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

import { existsSync, accessSync, constants } from "node:fs";
import path from "node:path";

export function truncate(text: string, maxLen = 20000): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... [truncated]";
}

export function oneLine(text: string | null | undefined, maxLen = 300): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > maxLen ? t.slice(0, maxLen) + "…" : t;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote|pre|hr)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function fmtNum(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "?";
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(1) + "B";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "K";
  return String(v);
}

/** Accepts ISO strings, Date, or unix seconds. */
export function fmtDate(d: string | number | Date | null | undefined): string {
  if (d === null || d === undefined || d === "") return "?";
  const date = typeof d === "number" ? new Date(d < 1e12 ? d * 1000 : d) : new Date(d);
  if (isNaN(date.getTime())) return "?";
  return date.toISOString().slice(0, 10);
}

export function fmtSize(bytes: number | null | undefined): string {
  const b = Number(bytes ?? 0);
  if (b >= 1_073_741_824) return (b / 1_073_741_824).toFixed(1) + "GB";
  if (b >= 1_048_576) return (b / 1_048_576).toFixed(1) + "MB";
  if (b >= 1024) return (b / 1024).toFixed(1) + "KB";
  return b + "B";
}

/** True when `target` resolves inside `dir` (used to confine file reads/writes). */
export function isWithinDir(dir: string, target: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function detectChromeExecutable(): string | null {
  const canExec = (p: string) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (process.platform === "win32") {
    for (const base of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      const p = `${base}\\Google\\Chrome\\Application\\chrome.exe`;
      if (existsSync(p)) return p;
    }
  } else if (process.platform === "darwin") {
    const p = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (canExec(p)) return p;
  } else {
    for (const p of [
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ]) {
      if (canExec(p)) return p;
    }
  }
  return null;
}
