// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

// Web tier: things the official API can't do without OAuth, done through a real
// browser session. Every endpoint here was taken from the site's own front-end
// (see docs/web-endpoints.md for evidence).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { WebClient } from "../clients/web-client.js";
import type { NexusApiClient } from "../clients/nexus-api.js";
import { resolveGameId } from "./graphql-api.js";
import { success, error, errMsg } from "../utils/types.js";
import { fmtDate, oneLine, truncate } from "../utils/helpers.js";

const WWW = "https://www.nexusmods.com";
const FORUMS = "https://forums.nexusmods.com";
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const game = z.string().min(1).describe('Game domain name, e.g. "skyrimspecialedition"');
const modId = z.number().int().positive();

// Site mutations, copied verbatim from next.nexusmods.com front-end chunks.
const CREATE_COMMENT = `mutation CreateComment($commentThreadId: ID!, $body: String!, $replyToId: ID, $attachmentIds: [ID!]) { createComment( commentThreadId: $commentThreadId body: $body replyToId: $replyToId attachmentIds: $attachmentIds ) { comment { id } } }`;
const UPDATE_COMMENT = `mutation UpdateComment($commentId: ID!, $body: String!, $attachmentIds: [ID!]) { updateComment(commentId: $commentId, body: $body, attachmentIds: $attachmentIds) { comment { id } } }`;
const DISCARD_COMMENT = `mutation DiscardComment($commentId: ID!) { discardComment(commentId: $commentId) { comment { id } } }`;

export function registerWebTools(server: McpServer, web: WebClient, api: NexusApiClient): void {
  const wrap = (name: string, fn: () => Promise<string>) => fn().then(success, (e) => error(`${name}: ${errMsg(e)}`));
  const threadCache = new Map<string, number>();

  /** Mod comments live in a legacy thread; its id is only exposed on the mod page. */
  async function modThread(g: string, id: number): Promise<{ gameId: number; threadId: number }> {
    const gameId = await resolveGameId(api, g);
    const key = `${g}/${id}`;
    let threadId = threadCache.get(key);
    if (!threadId) {
      const r = await web.parse("modThreadId", `${WWW}/${g}/mods/${id}`);
      if (!r.threadId) throw new Error(`no Posts thread found for ${key} (comments disabled, or mod hidden)`);
      threadId = r.threadId as number;
      threadCache.set(key, threadId);
    }
    return { gameId, threadId };
  }

  const widgetUrl = (gameId: number, id: number, threadId: number, page: number) =>
    `${WWW}/Core/Libs/Common/Widgets/CommentContainer?RH_CommentContainer=` +
    `game_id:${gameId},object_id:${id},object_type:1,thread_id:${threadId},tabbed:1,skip_opening_post:0,page:${page}`;

  // ── Session ────────────────────────────────────────────────────

  server.registerTool(
    "web_status",
    {
      title: "Web Session Status",
      description: "Check whether the browser session is logged in to nexusmods.com (needed only for web-tier WRITE tools).",
      inputSchema: {},
      annotations: READ,
    },
    () =>
      wrap("web_status", async () => {
        const login = web.loginInProgress() ? "Login in progress (sign-in window open). " : "";
        const who = await web.whoAmI();
        return `${login}${who.loggedIn ? "Logged in" : "NOT logged in"} (${who.detail}); cookies stored: ${web.hasCookies()}`;
      }),
  );

  server.registerTool(
    "web_login",
    {
      title: "Web Login",
      description:
        "Get a nexusmods.com session: extracts cookies from installed browsers, else opens a visible sign-in window (session captured automatically, persists across runs). Re-run your action after signing in.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    () => wrap("web_login", () => web.autoExtractCookies()),
  );

  server.registerTool(
    "web_set_cookies",
    {
      title: "Set Session Cookies",
      description: 'Manually set nexusmods.com cookies: a Cookie header string "name1=value1; name2=value2" from a logged-in browser.',
      inputSchema: { cookies: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ cookies }) => wrap("web_set_cookies", async () => `Saved ${web.setCookiesFromString(cookies)} cookies.`),
  );

  // ── Mod page comments (Posts tab) ──────────────────────────────

  server.registerTool(
    "get_mod_comments",
    {
      title: "Get Mod Comments (Posts tab)",
      description:
        "Read a mod page's Posts tab: threaded comments (id, author, date, text, inline replies), sticky first. 10 threads per page. Works without login.",
      inputSchema: { game, mod_id: modId, page: z.number().int().min(1).optional().default(1) },
      annotations: READ,
    },
    ({ game: g, mod_id, page }) =>
      wrap("get_mod_comments", async () => {
        const { gameId, threadId } = await modThread(g, mod_id);
        const d = await web.parse("modComments", widgetUrl(gameId, mod_id, threadId, page));
        const out = [`${d.total} comments on ${g}/${mod_id} (thread ${threadId}) — page ${d.page}/${d.pages}`];
        for (const c of d.comments) {
          const flags = [c.sticky ? "sticky" : "", c.locked ? "locked" : "", c.replies.length ? "" : "NO REPLIES"].filter(Boolean).join(", ");
          out.push(`[${c.id}] ${c.author} (${fmtDate(c.date)})${flags ? ` [${flags}]` : ""}: ${oneLine(c.text, 500)}`);
          for (const r of c.replies) out.push(`  └─ [${r.id}] ${r.author} (${fmtDate(r.date)}): ${oneLine(r.text, 300)}`);
        }
        return truncate(out.join("\n"));
      }),
  );

  async function commentToken(g: string, id: number): Promise<{ gameId: number; threadId: number; token: string }> {
    const { gameId, threadId } = await modThread(g, id);
    const d = await web.parse("modComments", widgetUrl(gameId, id, threadId, 1));
    if (!d.csrfToken) throw new Error("no comment form token — not logged in (run web_login) or comments are locked for you");
    return { gameId, threadId, token: d.csrfToken };
  }

  server.registerTool(
    "post_mod_comment",
    {
      title: "Post Mod Comment / Reply",
      description:
        "Post a comment on a mod's Posts tab, or reply to a comment (parent_id from get_mod_comments). Needs a logged-in web session. BBCode allowed.",
      inputSchema: {
        game,
        mod_id: modId,
        text: z.string().min(1),
        parent_id: z.number().int().positive().optional().describe("Comment id to reply to; omit for a new top-level comment"),
      },
      annotations: WRITE,
    },
    ({ game: g, mod_id, text, parent_id }) =>
      wrap("post_mod_comment", async () => {
        const { gameId, threadId, token } = await commentToken(g, mod_id);
        // Mirrors addNewComment() in the site's app bundle: POST /mod/comment, post is encodeURIComponent'd.
        const r = await web.postForm("/mod/comment", "POST", {
          game_id: gameId,
          object_id: mod_id,
          thread_id: threadId,
          post: encodeURIComponent(text),
          use_emo: 0,
          parent_id: parent_id ?? 0,
          _token: token,
        });
        if (r.status === 200 && r.body.trim() === "1") return `Posted ${parent_id ? `reply to ${parent_id}` : "comment"} on ${g}/${mod_id}.`;
        throw new Error(`HTTP ${r.status}: ${oneLine(r.body.replace(/<[^>]*>/g, " "), 300)}`);
      }),
  );

  server.registerTool(
    "edit_mod_comment",
    {
      title: "Edit Mod Comment",
      description: "Edit your own comment on a mod's Posts tab (comment_id from get_mod_comments). Needs a logged-in web session.",
      inputSchema: { game, mod_id: modId, comment_id: z.number().int().positive(), text: z.string().min(1) },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ game: g, mod_id, comment_id, text }) =>
      wrap("edit_mod_comment", async () => {
        const { token } = await commentToken(g, mod_id);
        // Mirrors editComment(): PUT /mod/comment {comment_id, use_emo, post, _token} → {errors, content}.
        const r = await web.postForm("/mod/comment", "PUT", {
          comment_id,
          use_emo: 0,
          post: encodeURIComponent(text),
          _token: token,
        });
        let errors = r.body;
        try {
          const j = JSON.parse(r.body);
          errors = typeof j === "object" && j ? (j.errors ?? "") : String(j);
        } catch {
          // plain text body = error message
        }
        if (r.status === 200 && !String(errors).trim()) return `Edited comment ${comment_id}.`;
        throw new Error(`HTTP ${r.status}: ${oneLine(String(errors).replace(/<[^>]*>/g, " "), 300)}`);
      }),
  );

  // ── Collection comments (GraphQL mutations via session, as next.nexusmods.com does) ──

  server.registerTool(
    "post_collection_comment",
    {
      title: "Post Collection Comment / Reply",
      description:
        "Comment on a collection (comment_thread_id from get_collection), or reply (reply_to_id). Uses the site's CreateComment mutation with the web session.",
      inputSchema: {
        comment_thread_id: z.string().min(1),
        body: z.string().min(1),
        reply_to_id: z.string().optional(),
      },
      annotations: WRITE,
    },
    ({ comment_thread_id, body, reply_to_id }) =>
      wrap("post_collection_comment", async () => {
        const d = await web.sessionGraphql("CreateComment", CREATE_COMMENT, {
          commentThreadId: comment_thread_id,
          body,
          replyToId: reply_to_id,
        });
        return `Posted comment ${d.createComment.comment.id}.`;
      }),
  );

  server.registerTool(
    "edit_collection_comment",
    {
      title: "Edit Collection Comment",
      description: "Edit your collection comment (UpdateComment mutation via web session).",
      inputSchema: { comment_id: z.string().min(1), body: z.string().min(1) },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ comment_id, body }) =>
      wrap("edit_collection_comment", async () => {
        const d = await web.sessionGraphql("UpdateComment", UPDATE_COMMENT, { commentId: comment_id, body });
        return `Edited comment ${d.updateComment.comment.id}.`;
      }),
  );

  server.registerTool(
    "delete_collection_comment",
    {
      title: "Delete Collection Comment",
      description: "Delete (discard) your collection comment (DiscardComment mutation via web session). Cannot be undone.",
      inputSchema: { comment_id: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ comment_id }) =>
      wrap("delete_collection_comment", async () => {
        const d = await web.sessionGraphql("DiscardComment", DISCARD_COMMENT, { commentId: comment_id });
        return `Deleted comment ${d.discardComment.comment.id}.`;
      }),
  );

  // ── Forums (forums.nexusmods.com, Invision Community) ──────────

  server.registerTool(
    "forum_list",
    {
      title: "Browse Forums",
      description:
        "List sub-forums and topics of a forum (forum_id or URL), or the forum index when omitted. Topics: id, title, author, date, replies, views. Works without login.",
      inputSchema: {
        forum: z.string().optional().describe('Forum id (e.g. "9063") or full forum URL; omit for the index'),
        page: z.number().int().min(1).optional().default(1),
      },
      annotations: READ,
    },
    ({ forum, page }) =>
      wrap("forum_list", async () => {
        let url = `${FORUMS}/`;
        // Invision needs "<id>-<slug>"; any slug resolves, a bare id 404s.
        if (forum) url = /^https?:/.test(forum) ? forum.replace(/[?#].*$/, "").replace(/\/?(page\/\d+\/?)?$/, "/") : `${FORUMS}/forum/${encodeURIComponent(forum)}-x/`;
        if (page > 1) url += `page/${page}/`;
        const d = await web.parse("forumPage", url);
        const out = [`${d.title} — page ${page}/${d.pages}`];
        if (d.forums.length) {
          out.push("forums:");
          for (const f of d.forums) out.push(`  [${f.id}] ${f.title}${f.posts ? ` (${f.posts} posts)` : ""} — ${oneLine(f.description, 100)}`);
        }
        if (d.topics.length) {
          out.push("topics:");
          for (const t of d.topics) out.push(`  [${t.id}] ${t.title} — ${t.author}, ${fmtDate(t.date)}, ${t.replies} replies, ${t.views} views`);
        }
        return truncate(out.join("\n"));
      }),
  );

  server.registerTool(
    "forum_topic",
    {
      title: "Read Forum Topic",
      description: "Read posts of a forum topic (topic id or URL), 25 per page. Works without login.",
      inputSchema: {
        topic: z.string().min(1).describe('Topic id (e.g. "13545622") or full topic URL'),
        page: z.number().int().min(1).optional().default(1),
      },
      annotations: READ,
    },
    ({ topic, page }) =>
      wrap("forum_topic", async () => {
        let url = /^https?:/.test(topic) ? topic.replace(/[?#].*$/, "").replace(/\/?(page\/\d+\/?)?$/, "/") : `${FORUMS}/topic/${encodeURIComponent(topic)}-x/`;
        if (page > 1) url += `page/${page}/`;
        const d = await web.parse("forumTopic", url);
        const out = [`${d.title} — page ${page}/${d.pages}`];
        for (const p of d.posts) out.push(`[${p.id}] ${p.author} (${fmtDate(p.date)}):\n${truncate(p.text, 2000)}`);
        return truncate(out.join("\n\n"));
      }),
  );

  // ── Forum / messenger writes (Invision quick-reply, as the forum's JS sends it) ──

  const topicUrl = (topic: string) =>
    /^https?:/.test(topic) ? topic.replace(/[?#].*$/, "").replace(/\/?(page\/\d+\/?)?$/, "/") : `${FORUMS}/topic/${encodeURIComponent(topic)}-x/`;

  /** Invision commentFeed.quickReply(): POST form.action with form.serialize() +
   *  `&currentPage=N&_lastSeenID=X` as XHR → JSON {type: error|redirect|add|merge, ...}. */
  async function invisionReply(pageUrl: string, text: string, html: boolean, dryRun: boolean): Promise<string> {
    await web.ensureForumSession();
    const f = await web.parse("invisionReplyForm", pageUrl);
    if (!f.editor) throw new Error("reply form has no editor field");
    const fields: [string, string][] = f.fields.map(([k, v]: [string, string]) => [k, k === f.editor ? toEditorHtml(text, html) : v]);
    fields.push(["currentPage", "1"], ["_lastSeenID", String(f.lastSeenId)]);
    if (dryRun) return dryRunReport("POST", f.action, fields, "XHR, application/x-www-form-urlencoded");
    const r = await web.submit({ url: f.action, fields, headers: { "X-Requested-With": "XMLHttpRequest" } });
    let j: any = null;
    try {
      j = JSON.parse(r.body);
    } catch {
      throw new Error(`HTTP ${r.status}: ${oneLine(r.body.replace(/<[^>]*>/g, " "), 300)}`);
    }
    if (r.status !== 200 || j?.type === "error") {
      const msg = j?.message || (j?.form ? oneLine(String(j.form).replace(/<[^>]*>/g, " "), 300) : r.body.slice(0, 300));
      throw new Error(`HTTP ${r.status}: ${msg}`);
    }
    return `Posted (response type: ${j?.type ?? "?"}${j?.id ? `, id ${j.id}` : ""}).`;
  }

  const textArg = z.string().min(1).describe("Message text (plain text; line breaks kept). Set html=true to pass editor HTML as-is.");
  const htmlArg = z.boolean().optional().default(false);
  const dryRunArg = z.boolean().optional().default(false).describe("Build the exact request (form token included) but do not send it");

  server.registerTool(
    "forum_reply",
    {
      title: "Reply to Forum Topic",
      description: "Post a reply in a forum topic (id or URL). Needs a logged-in web session (forum sign-in is done automatically via SSO).",
      inputSchema: { topic: z.string().min(1), text: textArg, html: htmlArg, dry_run: dryRunArg },
      annotations: WRITE,
    },
    ({ topic, text, html, dry_run }) => wrap("forum_reply", () => invisionReply(topicUrl(topic), text, html, dry_run)),
  );

  server.registerTool(
    "pm_list",
    {
      title: "List Private Messages",
      description: "List your private-message conversations (forum messenger): id, title, participants, last message snippet, unread flag. Needs a logged-in web session.",
      inputSchema: { page: z.number().int().min(1).optional().default(1) },
      annotations: READ,
    },
    ({ page }) =>
      wrap("pm_list", async () => {
        await web.ensureForumSession();
        const d = await web.parse("pmList", `${FORUMS}/messenger/${page > 1 ? `?page=${page}` : ""}`);
        if (!d.convs.length) return "No conversations.";
        const out = [`Conversations — page ${page}/${d.pages}`];
        for (const c of d.convs) out.push(`[${c.id}]${c.unread ? " (unread)" : ""} ${c.title} — ${c.participants}${c.date ? `, ${fmtDate(c.date)}` : ""}\n  ${oneLine(c.snippet, 200)}`);
        return out.join("\n");
      }),
  );

  server.registerTool(
    "pm_read",
    {
      title: "Read Private Conversation",
      description: "Read the messages of a private conversation (id from pm_list), 25 per page. Needs a logged-in web session.",
      inputSchema: { conversation_id: z.number().int().positive(), page: z.number().int().min(1).optional().default(1) },
      annotations: READ,
    },
    ({ conversation_id, page }) =>
      wrap("pm_read", async () => {
        await web.ensureForumSession();
        const d = await web.parse("forumTopic", `${FORUMS}/messenger/${conversation_id}/${page > 1 ? `?page=${page}` : ""}`);
        const out = [`${d.title} — page ${page}/${d.pages}${d.participants.length ? ` | participants: ${d.participants.join("; ")}` : ""}`];
        for (const p of d.posts) out.push(`[${p.id}] ${p.author} (${fmtDate(p.date)}):\n${truncate(p.text, 2000)}`);
        return truncate(out.join("\n\n"));
      }),
  );

  server.registerTool(
    "pm_send",
    {
      title: "Send Private Message",
      description: "Start a new private conversation with one or more members (forum messenger compose). Needs a logged-in web session.",
      inputSchema: {
        to: z.array(z.string().min(1)).min(1).describe("Recipient member names"),
        title: z.string().min(1),
        text: textArg,
        html: htmlArg,
        dry_run: dryRunArg,
      },
      annotations: WRITE,
    },
    ({ to, title, text, html, dry_run }) =>
      wrap("pm_send", async () => {
        await web.ensureForumSession();
        const f = await web.parse("invisionComposeForm", `${FORUMS}/messenger/compose/`);
        // The recipient autocomplete stores names newline-separated in messenger_to.
        const values: Record<string, string> = { messenger_to: to.join("\n"), messenger_title: title, messenger_content: toEditorHtml(text, html) };
        const fields: [string, string][] = f.fields.map(([k, v]: [string, string]) => [k, k in values ? values[k] : v]);
        if (dry_run) return dryRunReport("POST", f.action, fields, "multipart/form-data (native form submit)");
        const r = await web.submit({ url: f.action, fields, multipart: true });
        const m = r.url.match(/\/messenger\/(\d+)\//);
        if (m) return `Sent: conversation ${m[1]} (${r.url}).`;
        throw new Error(`not sent (HTTP ${r.status}): ${formError(r.body)}`);
      }),
  );

  server.registerTool(
    "pm_reply",
    {
      title: "Reply to Private Conversation",
      description: "Reply in an existing private conversation (id from pm_list). Needs a logged-in web session.",
      inputSchema: { conversation_id: z.number().int().positive(), text: textArg, html: htmlArg, dry_run: dryRunArg },
      annotations: WRITE,
    },
    ({ conversation_id, text, html, dry_run }) =>
      wrap("pm_reply", () => invisionReply(`${FORUMS}/messenger/${conversation_id}/`, text, html, dry_run)),
  );

  server.registerTool(
    "pm_leave",
    {
      title: "Leave (Delete) Private Conversation",
      description:
        "Leave a private conversation — removes it from your inbox (the conversation is deleted once no participants remain). Uses the conversation page's 'leave' link.",
      inputSchema: { conversation_id: z.number().int().positive(), dry_run: dryRunArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ conversation_id, dry_run }) =>
      wrap("pm_leave", async () => {
        const { csrfKey } = await web.ensureForumSession();
        const url = `${FORUMS}/messenger/${conversation_id}/?do=leaveConversation&csrfKey=${csrfKey}`;
        if (dry_run) return `DRY RUN — would send: GET ${url.replace(csrfKey, "<csrfKey>")}`;
        const r = await web.submit({ url, method: "GET" });
        if (r.status === 200 && !new RegExp(`/messenger/${conversation_id}/`).test(r.url)) return `Left conversation ${conversation_id}.`;
        throw new Error(`HTTP ${r.status} at ${r.url}: ${formError(r.body)}`);
      }),
  );
}

/** Invision's editor submits HTML. Plain text → one <p> per line, escaped. */
function toEditorHtml(text: string, html: boolean): string {
  if (html) return text;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => `<p>${l.trim() ? esc(l) : "&nbsp;"}</p>`)
    .join("\n");
}

/** Dry-run output: the exact request, with secret form tokens masked. */
export function dryRunReport(method: string, url: string, fields: [string, string][] | Record<string, unknown>, encoding: string): string {
  const mask = (k: string, v: string) => (/csrf|_token|plupload/i.test(k) ? `<${k} present, ${v.length} chars>` : v.length > 300 ? `${v.slice(0, 300)}…(${v.length} chars)` : v);
  const lines = Array.isArray(fields)
    ? fields.map(([k, v]) => `  ${k} = ${JSON.stringify(mask(k, v))}`)
    : Object.entries(fields).map(([k, v]) => `  ${k} = ${JSON.stringify(typeof v === "string" ? mask(k, v) : v)}`);
  return [`DRY RUN — not sent. ${method} ${url.replace(/csrfKey=\w+/, "csrfKey=<csrfKey>")} (${encoding})`, ...lines].join("\n");
}

/** First error/warning text of an Invision/legacy HTML response. */
function formError(body: string): string {
  const m = body.match(/class="[^"]*(?:ipsType_warning|ipsMessage_error|ipsFieldRow_error)[^"]*"[^>]*>([\s\S]{0,600}?)<\/(?:span|div|p|li)>/);
  const t = (m ? m[1] : body).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return t.slice(0, 300) || "(no message)";
}
