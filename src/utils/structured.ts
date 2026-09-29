// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

// Machine-readable output (`format: "json"`): the full result as MCP `structuredContent`
// plus the same JSON as the text block (clients that ignore structuredContent still get
// it). Text output of every tool stays the default and unchanged. The tools do not
// declare `outputSchema`: the SDK would then require structuredContent on text calls
// too. Shapes: README → "Structured output"; zod schemas in src/tools/json-shapes.ts.

import { z } from "zod/v4";
import type { ToolResult } from "./types.js";
import { errMsg } from "./types.js";

export const formatArg = z
  .enum(["text", "json"])
  .optional()
  .default("text")
  .describe('"json" = full untruncated machine-readable result (structuredContent); default "text"');

export type ErrorCode = "not_logged_in" | "cloudflare" | "not_found" | "disabled" | "rate_limited" | "invalid" | "error";

/** An error whose machine code is known where it is thrown. */
export class CodedError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Machine code for any thrown error: explicit CodedError, else from the message. */
export function errorCode(e: unknown): ErrorCode {
  if (e instanceof CodedError) return e.code;
  const m = errMsg(e);
  if (/not logged in|run web_login|session expired|UNAUTHORIZED|HTTP 401/i.test(m)) return "not_logged_in";
  if (/just a moment|cloudflare|cf[-_ ]challenge/i.test(m)) return "cloudflare";
  if (/HTTP 429|rate limit/i.test(m)) return "rate_limited";
  if (/HTTP 404|not found|unknown game domain/i.test(m)) return "not_found";
  if (/disabled|not available|comments are locked/i.test(m)) return "disabled";
  return "error";
}

export function jsonResult(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

export function jsonError(tool: string, e: unknown): ToolResult {
  const error = { code: errorCode(e), message: `${tool}: ${errMsg(e)}` };
  return { content: [{ type: "text", text: JSON.stringify({ error }) }], structuredContent: { error }, isError: true };
}

/** Unix seconds / ms / ISO / Date → ISO-8601 UTC, or null. */
export function isoUtc(d: string | number | Date | null | undefined): string | null {
  if (d === null || d === undefined || d === "" || d === 0) return null;
  const date = typeof d === "number" ? new Date(d < 1e12 ? d * 1000 : d) : new Date(d);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

/** Site-local "YYYY-MM-DD HH:MM" (no offset) → "YYYY-MM-DDTHH:MM", or null. */
export function localStamp(s: string | null | undefined): string | null {
  const m = (s ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/);
  return m ? `${m[1]}T${m[2]}` : null;
}
