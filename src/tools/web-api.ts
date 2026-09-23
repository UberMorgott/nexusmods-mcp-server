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
}
