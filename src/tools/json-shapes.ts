// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

// `format: "json"` result shapes (README → "Structured output"). Pure mappers from the
// parsers' / GraphQL output + the zod schemas they satisfy (checked by the tests).
// Ids are strings (stable site ids); timestamps ISO-8601 UTC unless named *Local.

import { z } from "zod/v4";
import { isoUtc, localStamp } from "../utils/structured.js";

const WWW = "https://www.nexusmods.com";
const iso = z.string().nullable();

// ── search_mods ──────────────────────────────────────────────────

export const ModSchema = z.object({
  game: z.string(),
  modId: z.number(),
  uid: z.string().nullable(),
  name: z.string(),
  version: z.string().nullable(),
  author: z.string().nullable(),
  uploader: z.object({ name: z.string().nullable(), memberId: z.number().nullable() }),
  summary: z.string(),
  downloads: z.number(),
  endorsements: z.number(),
  createdAt: iso,
  updatedAt: iso,
  url: z.string(),
});
export const ModsResultSchema = z.object({
  total: z.number(),
  offset: z.number(),
  count: z.number(),
  mods: z.array(ModSchema),
});

export function modsJson(d: { totalCount: number; nodes: any[] }, offset: number, count: number): z.infer<typeof ModsResultSchema> {
  return {
    total: Number(d.totalCount) || 0,
    offset,
    count,
    mods: d.nodes.map((m) => ({
      game: m.game?.domainName ?? "",
      modId: Number(m.modId),
      uid: m.uid != null ? String(m.uid) : null,
      name: m.name ?? "",
      version: m.version ?? null,
      author: m.author ?? null,
      uploader: { name: m.uploader?.name ?? null, memberId: m.uploader?.memberId != null ? Number(m.uploader.memberId) : null },
      summary: m.summary ?? "",
      downloads: Number(m.downloads) || 0,
      endorsements: Number(m.endorsements) || 0,
      createdAt: isoUtc(m.createdAt),
      updatedAt: isoUtc(m.updatedAt),
      url: `${WWW}/${m.game?.domainName}/mods/${m.modId}`,
    })),
  };
}

// ── get_mod_comments ─────────────────────────────────────────────

const CommentBase = {
  id: z.string(),
  parentId: z.string().nullable(),
  author: z.string(),
  authorId: z.number().nullable(),
  isModAuthor: z.boolean(),
  createdAt: iso,
  updatedAt: iso,
  body: z.string(),
};
export const ReplySchema = z.object(CommentBase);
export const ThreadSchema = z.object({ ...CommentBase, sticky: z.boolean(), locked: z.boolean(), replies: z.array(ReplySchema) });
export const ModCommentsResultSchema = z.object({
  game: z.string(),
  modId: z.number(),
  threadId: z.number(),
  page: z.number(),
  pages: z.number(),
  perPage: z.number(),
  total: z.number(),
  url: z.string(),
  comments: z.array(ThreadSchema),
});

export function modCommentsJson(g: string, modId: number, threadId: number, d: any): z.infer<typeof ModCommentsResultSchema> {
  const base = (c: any, parentId: string | null) => ({
    id: String(c.id),
    parentId,
    author: c.author,
    authorId: c.authorId ?? null,
    isModAuthor: !!c.isModAuthor,
    createdAt: isoUtc(c.date),
    updatedAt: null,
    body: c.text ?? "",
  });
  return {
    game: g,
    modId,
    threadId,
    page: d.page,
    pages: d.pages,
    perPage: 10,
    total: d.total,
    url: `${WWW}/${g}/mods/${modId}?tab=posts`,
    comments: d.comments.map((c: any) => ({
      ...base(c, null),
      sticky: !!c.sticky,
      locked: !!c.locked,
      replies: c.replies.map((r: any) => base(r, String(c.id))),
    })),
  };
}

// ── get_mod_bugs / get_mod_bug ───────────────────────────────────

export const BUG_STATUS_KEYS = ["new", "known", "looking", "fixed", "duplicate", "not_a_bug", "wont_fix", "need_info"] as const;
const CLOSED = new Set(["fixed", "duplicate", "not_a_bug", "wont_fix"]);

/** Bugs-tab status label ("New issue", "Being looked at", "Won't fix", …) → key, or null. */
export function bugStatusKey(label: string): (typeof BUG_STATUS_KEYS)[number] | null {
  const l = label.toLowerCase();
  if (l.includes("new")) return "new";
  if (l.includes("looked")) return "looking";
  if (l.includes("known")) return "known";
  if (l.includes("duplicate")) return "duplicate";
  if (l.includes("not a bug")) return "not_a_bug";
  if (/won.?t fix/.test(l)) return "wont_fix";
  if (l.includes("fixed")) return "fixed";
  if (l.includes("need")) return "need_info";
  return null;
}

export const BugSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  statusKey: z.enum(BUG_STATUS_KEYS).nullable(),
  open: z.boolean(),
  replies: z.number(),
  version: z.string(),
  priority: z.string(),
  lastPostAt: iso,
});
export const ModBugsResultSchema = z.object({
  game: z.string(),
  modId: z.number(),
  filter: z.string(),
  page: z.number(),
  pages: z.number(),
  perPage: z.number(),
  canReport: z.boolean(),
  url: z.string(),
  bugs: z.array(BugSchema),
});

export function modBugsJson(g: string, modId: number, filter: string, page: number, d: any): z.infer<typeof ModBugsResultSchema> {
  return {
    game: g,
    modId,
    filter,
    page,
    pages: d.pages,
    perPage: 10,
    canReport: !!d.canReport,
    url: `${WWW}/${g}/mods/${modId}?tab=bugs`,
    bugs: d.bugs.map((b: any) => {
      const key = bugStatusKey(b.status);
      return {
        id: String(b.id),
        title: b.title,
        status: b.status,
        statusKey: key,
        open: !key || !CLOSED.has(key),
        replies: Number(b.replies) || 0,
        version: b.version,
        priority: b.priority,
        lastPostAt: isoUtc(b.lastPost),
      };
    }),
  };
}

const BugPost = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  author: z.string(),
  authorId: z.number().nullable(),
  createdAt: iso,
  createdAtLocal: z.string().nullable(),
  body: z.string(),
});
export const ModBugResultSchema = z.object({
  issueId: z.string(),
  canReply: z.boolean(),
  report: BugPost,
  replies: z.array(BugPost),
});

/** Bug posts carry only a site-local time (logged-in profile's zone, no offset): createdAt stays null. */
export function modBugJson(issueId: number, d: any): z.infer<typeof ModBugResultSchema> {
  const post = (p: any, parentId: string | null) => ({
    id: String(p.id),
    parentId,
    author: p.author,
    authorId: p.authorId ?? null,
    createdAt: null,
    createdAtLocal: localStamp(p.date),
    body: p.text ?? "",
  });
  const report = d.posts.find((p: any) => p.isReport) ?? d.posts[0];
  return {
    issueId: String(issueId),
    canReply: !!d.replyToken,
    report: post(report, null),
    replies: d.posts.filter((p: any) => p !== report).map((p: any) => post(p, String(issueId))),
  };
}

// ── writes / session ─────────────────────────────────────────────

export const PostResultSchema = z.object({
  posted: z.boolean(),
  dryRun: z.boolean(),
  id: z.string().nullable(),
  parentId: z.string().nullable(),
  verified: z.boolean(),
  httpStatus: z.number().nullable(),
  request: z.string().optional(),
});

export const StatusResultSchema = z.object({
  loggedIn: z.boolean(),
  loginInProgress: z.boolean(),
  cookiesStored: z.boolean(),
  detail: z.string(),
});

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Read-back after a post that returns no id: newest matching own post. */
export function findPosted(posts: { id: string; text: string }[], text: string, notIn: Set<string>): string | null {
  const hits = posts.filter((p) => !notIn.has(String(p.id)) && norm(p.text) === norm(text));
  if (!hits.length) return null;
  return hits.map((p) => String(p.id)).sort((a, b) => Number(b) - Number(a))[0];
}
