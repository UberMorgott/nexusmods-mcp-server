// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

// `format: "json"` shapes: saved site widgets (test/fixtures, trimmed, other members
// anonymized, csrf tokens replaced) → the in-page parser (jsdom) → json mappers → schemas.
// No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { fetchAndParse } from "../src/clients/site-parsers.js";
import {
  modCommentsJson,
  ModCommentsResultSchema,
  modBugsJson,
  ModBugsResultSchema,
  modBugJson,
  ModBugResultSchema,
  modsJson,
  ModsResultSchema,
  bugStatusKey,
  findPosted,
  PostResultSchema,
  StatusResultSchema,
} from "../src/tools/json-shapes.js";
import { jsonResult, jsonError, errorCode, CodedError, isoUtc, localStamp, afterSendError, refusedStatus } from "../src/utils/structured.js";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

(globalThis as any).DOMParser = new JSDOM("").window.DOMParser;

async function parseFixture(kind: any, file: string, status = 200) {
  const html = fixture(file);
  (globalThis as any).fetch = async () => new Response(html, { status });
  return fetchAndParse({ kind, url: "https://www.nexusmods.com/x" });
}

test("get_mod_comments json: threads, sticky, replies, full bodies, member ids", async () => {
  const d = await parseFixture("modComments", "nexus-comments.html");
  const j = ModCommentsResultSchema.parse(modCommentsJson("windrose", 147, 16796543, d));
  assert.equal(j.total, 32);
  assert.equal(j.page, 1);
  assert.equal(j.pages, 2); // 10 threads per page; total counts replies too
  assert.equal(j.perPage, 10);
  assert.equal(j.comments.length, 3);
  const sticky = j.comments[0];
  assert.equal(sticky.id, "168798341");
  assert.equal(sticky.sticky, true);
  assert.equal(sticky.parentId, null);
  assert.equal(sticky.author, "UberMorgott");
  assert.equal(sticky.authorId, 6541781);
  assert.equal(sticky.createdAt, "2026-04-26T10:10:25.000Z");
  // untruncated: text tool cut at 500 chars
  assert.ok(sticky.body.length > 1500, `body ${sticky.body.length}`);
  assert.ok(sticky.body.includes("\n"), "line breaks kept");
  assert.ok(sticky.body.includes("R5LogCheck"), "code block kept");
  const withReplies = j.comments.find((c) => c.replies.length);
  assert.ok(withReplies, "a thread with replies");
  for (const r of withReplies!.replies) {
    assert.equal(r.parentId, withReplies!.id);
    assert.match(r.id, /^\d+$/);
    assert.ok(r.createdAt?.endsWith("Z"));
  }
  assert.ok(j.comments.some((c) => c.isModAuthor || c.replies.some((r) => r.isModAuthor)), "mod-author flag");
  assert.ok(j.comments.flatMap((c) => [c, ...c.replies]).every((c) => c.authorId !== null));
});

test("get_mod_bugs json: rows, status keys, open flag, UTC last post", async () => {
  const d = await parseFixture("modBugs", "nexus-bugs.html");
  assert.equal(d.enabled, true);
  const j = ModBugsResultSchema.parse(modBugsJson("baldursgate3", 141, "all", 1, d));
  assert.equal(j.bugs.length, 3);
  assert.ok(j.pages >= 2);
  const b = j.bugs[0];
  assert.equal(b.id, "1138938");
  assert.equal(b.title, "Human BT2 not showing the body, Just human.");
  assert.equal(b.status, "New issue");
  assert.equal(b.statusKey, "new");
  assert.equal(b.open, true);
  assert.equal(b.replies, 0);
  assert.equal(b.lastPostAt, "2026-09-24T13:08:03.000Z");
});

test("get_mod_bugs: disabled tab parses as not enabled", async () => {
  const d = await parseFixture("modBugs", "nexus-bugs-disabled.html");
  assert.equal(d.enabled, false);
  assert.equal(d.bugs.length, 0);
});

test("bug status labels (site filter options) → keys", () => {
  const m: Record<string, string> = {
    "New issue": "new",
    "Being looked at": "looking",
    "Known issue": "known",
    Fixed: "fixed",
    Duplicate: "duplicate",
    "Not a bug": "not_a_bug",
    "Won't fix": "wont_fix",
    "Need more info": "need_info",
  };
  for (const [label, key] of Object.entries(m)) assert.equal(bugStatusKey(label), key, label);
  const open = (s: string) => modBugsJson("g", 1, "all", 1, { pages: 1, bugs: [{ id: 1, title: "t", status: s, replies: "2", version: "", priority: "", lastPost: 0 }] }).bugs[0];
  assert.equal(open("Fixed").open, false);
  assert.equal(open("Won't fix").open, false);
  assert.equal(open("Need more info").open, true);
  assert.equal(open("Fixed").lastPostAt, null);
});

test("get_mod_bug json: report + replies, author id, local time", async () => {
  const d = await parseFixture("modBugReplies", "nexus-bug.html");
  const j = ModBugResultSchema.parse(modBugJson(1138938, d));
  assert.equal(j.issueId, "1138938");
  assert.equal(j.canReply, true);
  assert.equal(j.report.id, "1138938");
  assert.equal(j.report.parentId, null);
  assert.equal(j.report.authorId, 9000004); // fixture: member anonymized
  assert.equal(j.report.createdAt, null);
  assert.equal(j.report.createdAtLocal, "2026-09-24T17:08");
  assert.ok(j.report.body.startsWith("I have an odd one"));
  assert.ok(!j.report.body.includes("Add a reply"), "reply form stripped");
  assert.deepEqual(j.replies, []);
  const withReply = modBugJson(5, { replyToken: null, posts: [{ id: "5", isReport: true, author: "a", date: "", text: "r" }, { id: "9", isReport: false, author: "b", authorId: 2, date: "2026-01-02 03:04", text: "x" }] });
  assert.equal(withReply.replies[0].parentId, "5");
  assert.equal(withReply.canReply, false);
});

test("search_mods json", () => {
  const j = ModsResultSchema.parse(
    modsJson(
      {
        totalCount: 1,
        nodes: [{ modId: 147, uid: "38014960271507", name: "ShareShip", version: "1.1.1", author: "UberMorgott", summary: "s", downloads: 10, endorsements: 2, createdAt: "2026-04-20T10:00:00Z", updatedAt: "2026-04-27T10:00:00Z", uploader: { name: "UberMorgott", memberId: 6541781 }, game: { domainName: "windrose" } }],
      },
      0,
      10,
    ),
  );
  assert.equal(j.mods[0].url, "https://www.nexusmods.com/windrose/mods/147");
  assert.equal(j.mods[0].uploader.memberId, 6541781);
  assert.equal(j.mods[0].createdAt, "2026-04-20T10:00:00.000Z");
});

test("json result / error envelope and codes", () => {
  const ok = jsonResult({ a: 1 });
  assert.deepEqual(ok.structuredContent, { a: 1 });
  assert.equal(JSON.parse(ok.content[0].text).a, 1);
  const err = jsonError("get_mod_bugs", new CodedError("disabled", "Bug reports are not available"));
  assert.equal(err.isError, true);
  assert.deepEqual((err.structuredContent as any).error.code, "disabled");
  assert.equal(errorCode(new Error("no comment form token — not logged in (run web_login)")), "not_logged_in");
  assert.equal(errorCode(new Error("HTTP 403: Just a moment...")), "cloudflare");
  assert.equal(errorCode(new Error("HTTP 429 GET x")), "rate_limited");
  assert.equal(errorCode(new Error("HTTP 404: gone")), "not_found");
  assert.equal(errorCode(new Error("boom")), "error");
  PostResultSchema.parse({ posted: true, dryRun: false, id: "1", parentId: null, verified: true, httpStatus: 200 });
  StatusResultSchema.parse({ loggedIn: false, loginInProgress: false, cookiesStored: false, detail: "UNAUTHORIZED" });
});

test("write errors after the request was sent: 4xx refused, else outcome_unknown", () => {
  assert.equal(errorCode(afterSendError(null, "POST /mod/comment: Target page closed")), "outcome_unknown");
  assert.equal(errorCode(afterSendError(500, "HTTP 500: server error")), "outcome_unknown");
  assert.equal(errorCode(afterSendError(502, "HTTP 502: not found upstream")), "outcome_unknown");
  assert.equal(errorCode(afterSendError(200, "HTTP 200: odd body")), "outcome_unknown");
  assert.equal(errorCode(afterSendError(408, "HTTP 408: timeout")), "outcome_unknown");
  assert.equal(errorCode(afterSendError(401, "HTTP 401: nope")), "not_logged_in");
  assert.equal(errorCode(afterSendError(429, "HTTP 429: slow down")), "rate_limited");
  assert.equal(errorCode(afterSendError(422, "HTTP 422: bad")), "error");
  assert.equal(refusedStatus(403), true);
  assert.equal(refusedStatus(503), false);
});

test("read-back finds the new post id, ignoring older identical text", () => {
  const posts = [
    { id: "10", text: "hello  world" },
    { id: "12", text: "hello world" },
    { id: "11", text: "other" },
  ];
  assert.equal(findPosted(posts, "hello world", new Set(["10"])), "12");
  assert.equal(findPosted(posts, "hello world", new Set(["10", "12"])), null);
});

test("timestamps", () => {
  assert.equal(isoUtc(1777198225), "2026-04-26T10:10:25.000Z");
  assert.equal(isoUtc(0), null);
  assert.equal(localStamp("2026-09-24 17:08"), "2026-09-24T17:08");
  assert.equal(localStamp("24 Sep"), null);
});
