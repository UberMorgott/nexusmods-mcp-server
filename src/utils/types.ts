// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export function success(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function error(text: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
