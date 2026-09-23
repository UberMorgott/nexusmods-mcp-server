// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

// Web tier, mod pages: bug reports, comment hiding, media and page editing. Every request
// mirrors what the site's own front-end sends (legacy jQuery bundle for bugs/comments,
// the Next.js mod editor "flamework" API for media and page edits) — evidence in
// docs/web-endpoints.md.

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { WebClient } from "../clients/web-client.js";
import type { NexusApiClient } from "../clients/nexus-api.js";
import { WWW_ORIGIN } from "../clients/browser-client.js";
import { resolveGameId } from "./graphql-api.js";
import { dryRunReport } from "./web-api.js";
import { success, error, errMsg } from "../utils/types.js";
import { fmtDate, oneLine, truncate } from "../utils/helpers.js";

const WWW = WWW_ORIGIN;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

const game = z.string().min(1).describe('Game domain name, e.g. "skyrimspecialedition"');
const modId = z.number().int().positive();
const dryRunArg = z.boolean().optional().default(false).describe("Build the exact request (form token included) but do not send it");

const BUG_STATUS = { all: -1, new: 0, known: 1, looking: 2, fixed: 3, duplicate: 4, not_a_bug: 5, wont_fix: 6, need_info: 7 } as const;

/** Site query from the mod editor (next.nexusmods.com /games/<game>/mods/<id>/edit), verbatim. */
const MOD_EDIT_QUERY = `
    query Mod($modId: ID!, $gameId: ID!) {
  mod(modId: $modId, gameId: $gameId) {
    author
    description
    game {
      domainName
      id
      name
      supportsVortex
    }
    gameId
    legacyModRequirementsEnabled
    mirrors {
      id
      name
      uri
    }
    modCategory {
      categoryId
      name
    }
    modId
    name
    summary
    tags {
      id
      name
    }
    uid
    uploader {
      avatar
      memberId
      name
    }
    version
  }
}
    `;

const CSAM_QUERY = `
    query CsamHashCheck($md5Hashes: [String!]!) {
  csamHashCheck(md5Hashes: $md5Hashes) {
    hashValue
    match
  }
}
    `;

const IMAGE_TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif" };
const IMAGE_MAX_BYTES = 8_388_608; // IMAGE_MAX_SIZE_BYTES in the editor bundle
const YOUTUBE_RE = /^(https?:\/\/)?(www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)[\w-]+/;

/** decodeBBCode() of the mod editor, run INSIDE the page (entity decoding via the DOM). */
function decodeBBCodeInPage(list: string[]): string[] {
  const ta = document.createElement("textarea");
  const dec = (s: string) =>
    s.replace(/&(#\d+|#[xX][\da-fA-F]+|[0-9a-zA-Z]+);/g, (m) => {
      ta.innerHTML = m;
      return ta.value;
    });
  return list.map((e) =>
    e
      ? dec(
          e
            .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
            .replace(/[ \t]*\n?[ \t]*<br\s*\/?>[ \t]*\n?[ \t]*/gi, "\n")
            .replace(/&nbsp;/gi, " "),
        )
      : "",
  );
}

export function registerWebModTools(server: McpServer, web: WebClient, api: NexusApiClient): void {
  const wrap = (name: string, fn: () => Promise<string>) => fn().then(success, (e) => error(`${name}: ${errMsg(e)}`));

  /** POST JSON to the editor's flamework API (flameworkFetch: credentials include, JSON). */
  async function flamework(pathname: string, body: unknown): Promise<any> {
    const r = await web.submit({ url: `${WWW}${pathname}`, json: body });
    let j: any = null;
    try {
      j = JSON.parse(r.body);
    } catch {
      // non-JSON body → reported below
    }
    if (r.status < 200 || r.status >= 300 || !j) throw new Error(`HTTP ${r.status}: ${oneLine(j?.error || j?.message || r.body.replace(/<[^>]*>/g, " "), 300)}`);
    return j;
  }

  async function flameworkGet(pathname: string): Promise<any> {
    const r = await web.submit({ url: `${WWW}${pathname}`, method: "GET" });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${oneLine(r.body.replace(/<[^>]*>/g, " "), 300)}`);
    return JSON.parse(r.body);
  }

  // ── Bug reports (mod page Bugs tab, legacy widgets) ────────────

  const bugsUrl = (gameId: number, id: number, page: number, status: number) =>
    `${WWW}/Core/Libs/Common/Widgets/ModBugsTab?RH_ModBugsTab=game_id:${gameId},id:${id},page_size:10,page:${page}${status >= 0 ? `,status:${status}` : ""}`;

  server.registerTool(
    "get_mod_bugs",
    {
      title: "Get Mod Bug Reports",
      description: "List a mod's bug reports (Bugs tab): id, title, status, replies, version, priority, last post. 10 per page. Works without login (private reports need the author's session).",
      inputSchema: {
        game,
        mod_id: modId,
        page: z.number().int().min(1).optional().default(1),
        status: z.enum(Object.keys(BUG_STATUS) as [keyof typeof BUG_STATUS]).optional().default("all"),
      },
      annotations: READ,
    },
    ({ game: g, mod_id, page, status }) =>
      wrap("get_mod_bugs", async () => {
        const gameId = await resolveGameId(api, g);
        const d = await web.parse("modBugs", bugsUrl(gameId, mod_id, page, BUG_STATUS[status]));
        if (!d.enabled) return `Bug reports are not available for ${g}/${mod_id}.`;
        if (!d.bugs.length) return `No bug reports (${status}) on ${g}/${mod_id}.`;
        const out = [`Bug reports on ${g}/${mod_id} (${status}) — page ${page}/${d.pages}`];
        for (const b of d.bugs) out.push(`[${b.id}] ${b.title} — ${b.status}, ${b.replies} replies, priority ${b.priority}, ${b.version}, last ${fmtDate(b.lastPost)}`);
        return out.join("\n");
      }),
  );

  server.registerTool(
    "get_mod_bug",
    {
      title: "Read Mod Bug Report",
      description: "Read one bug report and its replies (issue_id from get_mod_bugs).",
      inputSchema: { issue_id: z.number().int().positive() },
      annotations: READ,
    },
    ({ issue_id }) =>
      wrap("get_mod_bug", async () => {
        const d = await web.parse("modBugReplies", `${WWW}/Core/Libs/Common/Widgets/ModBugReplyList`, { issue_id: String(issue_id) });
        if (!d.posts.length) return `Bug report ${issue_id} not found or not visible to you.`;
        return truncate(d.posts.map((p: any) => `${p.isReport ? "REPORT" : "reply"} [${p.id}] ${p.author} (${p.date}):\n${truncate(p.text, 3000)}`).join("\n\n"));
      }),
  );

  server.registerTool(
    "post_mod_bug",
    {
      title: "Post Mod Bug Report",
      description: "File a new bug report on a mod (Bugs tab → Report a bug). BBCode allowed. Needs a logged-in web session.",
      inputSchema: {
        game,
        mod_id: modId,
        title: z.string().min(1),
        text: z.string().min(1).max(5000),
        private: z.boolean().optional().default(false).describe("Make it a private report (visible to the author only)"),
        dry_run: dryRunArg,
      },
      annotations: WRITE,
    },
    ({ game: g, mod_id, title, text, private: priv, dry_run }) =>
      wrap("post_mod_bug", async () => {
        const gameId = await resolveGameId(api, g);
        const f = await web.parse("bugReportForm", `${WWW}/Core/Libs/Common/Widgets/AddBugReportPopUp?game_id=${gameId}&mod_id=${mod_id}`);
        if (!f.token) throw new Error(`no bug report form token — not logged in (run web_login) or reports disabled: ${f.message}`);
        // addBugReport() in the site's app bundle: POST /mod_bug; make_private is a jQuery-serialized boolean.
        const fields: Record<string, string> = {
          mod_id: String(mod_id),
          game_id: String(gameId),
          title,
          content: text,
          make_private: String(priv),
          _token: f.token,
        };
        if (dry_run) return dryRunReport("POST", `${WWW}/mod_bug`, Object.entries(fields), "XHR, application/x-www-form-urlencoded");
        const r = await web.postForm("/mod_bug", "POST", fields);
        if (r.status === 200 && r.body.trim() === "1") return `Bug report "${title}" posted on ${g}/${mod_id} (see get_mod_bugs).`;
        throw new Error(`HTTP ${r.status}: ${oneLine(r.body.replace(/<[^>]*>/g, " "), 300)}`);
      }),
  );

  server.registerTool(
    "reply_mod_bug",
    {
      title: "Reply to Mod Bug Report",
      description: "Reply to a bug report (issue_id from get_mod_bugs). BBCode allowed. Needs a logged-in web session.",
      inputSchema: { issue_id: z.number().int().positive(), text: z.string().min(1).max(5000), dry_run: dryRunArg },
      annotations: WRITE,
    },
    ({ issue_id, text, dry_run }) =>
      wrap("reply_mod_bug", async () => {
        const d = await web.parse("modBugReplies", `${WWW}/Core/Libs/Common/Widgets/ModBugReplyList`, { issue_id: String(issue_id) });
        if (!d.replyToken) throw new Error("no reply form token — not logged in (run web_login), issue closed, or not visible");
        const fields = { content: text, _token: d.replyToken };
        const url = `/mod_bug/${issue_id}/reply`;
        if (dry_run) return dryRunReport("POST", `${WWW}${url}`, Object.entries(fields), "XHR, application/x-www-form-urlencoded");
        const r = await web.postForm(url, "POST", fields);
        let j: any = null;
        try {
          j = JSON.parse(r.body);
        } catch {
          // plain body → error
        }
        if (r.status === 200 && j?.status === true) return `Replied to bug report ${issue_id}.`;
        throw new Error(`HTTP ${r.status}: ${oneLine(j?.message || r.body.replace(/<[^>]*>/g, " "), 300)}`);
      }),
  );

  server.registerTool(
    "delete_mod_bug",
    {
      title: "Delete Mod Bug Report (author)",
      description: "Delete a bug report and all its replies from YOUR mod (mod author/moderator only). Cannot be undone.",
      inputSchema: { issue_id: z.number().int().positive(), dry_run: dryRunArg },
      annotations: DESTRUCTIVE,
    },
    ({ issue_id, dry_run }) =>
      wrap("delete_mod_bug", async () => {
        // deleteIssue() in the site's app bundle.
        const url = "/Core/Libs/Common/Entities/ModBugIssue?DeleteIssue";
        if (dry_run) return dryRunReport("POST", `${WWW}${url}`, [["issue_id", String(issue_id)]], "XHR, application/x-www-form-urlencoded");
        const r = await web.postForm(url, "POST", { issue_id });
        if (r.status === 200 && r.body.trim() === "1") return `Deleted bug report ${issue_id}.`;
        throw new Error(`HTTP ${r.status}: ${oneLine(r.body.replace(/<[^>]*>/g, " "), 300)}`);
      }),
  );

  // ── Mod page comments: hide (the site's removal action) ────────

  server.registerTool(
    "hide_mod_comment",
    {
      title: "Hide Mod Comment",
      description:
        "Hide a comment on a mod's Posts tab — the site's 'Hide and optionally report post' action (removes it from view for everyone except staff). Available to the mod's author for any comment on their mod. Needs a logged-in web session.",
      inputSchema: {
        game,
        mod_id: modId,
        comment_id: z.number().int().positive(),
        reason: z.string().optional().default("").describe("Optional reason"),
        report: z.boolean().optional().default(false).describe("Also report the comment to staff"),
        dry_run: dryRunArg,
      },
      annotations: DESTRUCTIVE,
    },
    ({ game: g, mod_id, comment_id, reason, report, dry_run }) =>
      wrap("hide_mod_comment", async () => {
        const gameId = await resolveGameId(api, g);
        const p = await web.parse(
          "hideCommentPopup",
          `${WWW}/Core/Libs/Common/Widgets/DeleteAndReportCommentPopUp?game_id=${gameId}&object_id=${mod_id}&object_type=1&comment_id=${comment_id}`,
        );
        // .delete-and-report-comment click handler in the site's app bundle.
        const fields: Record<string, string> = {
          game_id: p.gameId,
          reason,
          object_id: p.objectId,
          comment_id: p.commentId,
          object_type: p.objectType,
          status: p.status,
          report: report ? "1" : "0",
        };
        const url = "/Core/Libs/Common/Managers/Moderation/ChangeCommentModerationStatus";
        if (dry_run) return dryRunReport("POST", `${WWW}${url}`, Object.entries(fields), "XHR, application/x-www-form-urlencoded");
        const r = await web.postForm(url, "POST", fields);
        let j: any = null;
        try {
          j = JSON.parse(r.body);
        } catch {
          // plain body → error
        }
        if (r.status === 200 && j?.status === true) return `Hid comment ${comment_id}: ${oneLine(String(j.message ?? ""), 200)}`;
        throw new Error(`HTTP ${r.status}: ${oneLine(String(j?.message ?? r.body).replace(/<[^>]*>/g, " "), 300)}`);
      }),
  );

  // ── Media (mod editor: /games/<game>/mods/<id>/edit/media) ─────

  server.registerTool(
    "get_mod_media",
    {
      title: "Get Mod Media (author)",
      description: "List a mod's author images (id, url, title, primary/thumbnail) and videos as the mod editor shows them. Author/editor session required.",
      inputSchema: { game, mod_id: modId },
      annotations: READ,
    },
    ({ game: g, mod_id }) =>
      wrap("get_mod_media", async () => {
        const gameId = await resolveGameId(api, g);
        const d = await flameworkGet(`/api/flamework/mods/media?gameId=${gameId}&modId=${mod_id}`);
        const out = [`Media of ${g}/${mod_id}: images allowed ${d.settings?.allowImages ?? "?"}, videos allowed ${d.settings?.allowVideos ?? "?"}`];
        // Relative image paths resolve under NEXT_PUBLIC_CONTENTS_IMAGES_DOMAIN, as in the editor.
        const img = (u: string) => (/^https?:/.test(u) ? u : `https://staticdelivery.nexusmods.com/mods/${gameId}/images/${u}`);
        if (d.headerImage) out.push(`header: ${img(d.headerImage)}`);
        const listImages = (label: string, imgs: any[]) => {
          out.push(`${label} (${imgs.length}):`);
          for (const i of imgs) out.push(`  [${i.id}] ${img(i.url ?? "")}${i.title ? ` "${i.title}"` : ""}${i.isPrimary ? " (thumbnail)" : ""}${i.isVerified ? "" : " (unverified)"} ${fmtDate(i.date)}`);
        };
        listImages("author images", d.authorImages ?? []);
        if (d.hiddenImages?.length) listImages("hidden images", d.hiddenImages);
        const vids: any[] = d.authorVideos ?? [];
        out.push(`author videos (${vids.length}):`);
        for (const v of vids) out.push(`  [${v.id}] "${v.title}" ${v.url} (type ${v.type}, ${v.views} views)`);
        const ui = d.userImages?.counts;
        const uv = d.userVideos;
        out.push(`user images: ${ui?.approved ?? 0} approved, ${ui?.pending ?? 0} pending | user videos: ${uv?.approved?.length ?? 0} approved, ${uv?.pending?.length ?? 0} pending`);
        return out.join("\n");
      }),
  );

  server.registerTool(
    "upload_mod_image",
    {
      title: "Upload Mod Image (author)",
      description:
        "Upload an image (JPG/PNG/GIF, max 8 MB) to YOUR mod's gallery, as the mod editor does: image safety hash check, upload, media cache refresh. Needs the author's web session.",
      inputSchema: {
        game,
        mod_id: modId,
        file_path: z.string().min(1).describe("Absolute path to the image file"),
        show_in_gallery: z.boolean().optional().default(true),
        dry_run: dryRunArg,
      },
      annotations: WRITE,
    },
    ({ game: g, mod_id, file_path, show_in_gallery, dry_run }) =>
      wrap("upload_mod_image", async () => {
        const type = IMAGE_TYPES[path.extname(file_path).toLowerCase()];
        if (!type) throw new Error("Unsupported file type. Use JPG, PNG or GIF.");
        const size = statSync(file_path).size;
        if (size > IMAGE_MAX_BYTES) throw new Error(`Exceeds the 8MB size limit (${size} bytes).`);
        const gameId = await resolveGameId(api, g);
        const bytes = readFileSync(file_path);
        // checkCsamContent(): md5 of the file bytes → api-router CsamHashCheck; upload only on match === false.
        const md5 = createHash("md5").update(bytes).digest("hex");
        const c = await web.sessionGraphql<any>("CsamHashCheck", CSAM_QUERY, { md5Hashes: [md5] });
        const match = c?.csamHashCheck?.[0]?.match;
        if (match !== false) throw new Error(match ? "Image rejected by the site's safety hash check." : "Image safety check could not be completed.");
        const url = `${WWW}/api/games/${gameId}/mods/${mod_id}/images`;
        const fields: [string, string][] = show_in_gallery ? [] : [["show_in_gallery", "0"]];
        if (dry_run)
          return `${dryRunReport("POST", url, [["image", `<file ${path.basename(file_path)}, ${type}, ${size} bytes>`], ...fields], "multipart/form-data, Accept: application/json")}\nsafety check: passed (md5 ${md5})\nthen: POST ${WWW}/api/flamework/mods/media/save {gameId:${gameId}, modId:${mod_id}}`;
        const r = await web.submit({
          url,
          fields,
          file: { field: "image", name: path.basename(file_path), type, b64: bytes.toString("base64") },
          headers: { Accept: "application/json" },
        });
        let j: any = null;
        try {
          j = JSON.parse(r.body);
        } catch {
          // non-JSON → error below
        }
        if (r.status < 200 || r.status >= 300 || !j?.status) throw new Error(`HTTP ${r.status}: ${oneLine(String(j?.message ?? r.body).replace(/<[^>]*>/g, " "), 300)}`);
        const imageId = String(j.message ?? "").match(/data-image-id="(\d+)"/)?.[1];
        await flamework("/api/flamework/mods/media/save", { gameId, modId: mod_id }).catch(() => {});
        return `Uploaded image${imageId ? ` ${imageId}` : ""} to ${g}/${mod_id}${j.verified === false ? " (awaiting verification)" : ""}.`;
      }),
  );

  server.registerTool(
    "delete_mod_image",
    {
      title: "Delete Mod Image (author)",
      description: "Delete an image from YOUR mod's gallery (image_id from get_mod_media). Cannot be undone.",
      inputSchema: { game, mod_id: modId, image_id: z.number().int().positive(), dry_run: dryRunArg },
      annotations: DESTRUCTIVE,
    },
    ({ game: g, mod_id, image_id, dry_run }) =>
      wrap("delete_mod_image", async () => {
        const gameId = await resolveGameId(api, g);
        // postImageAction("delete", {gameId, imageId}) in the mod editor.
        const body = { action: "delete", gameId, imageId: image_id };
        if (dry_run) return dryRunReport("POST", `${WWW}/api/flamework/mods/media/images`, body, "application/json");
        const j = await flamework("/api/flamework/mods/media/images", body);
        if (!j.success) throw new Error(`site answered success=false`);
        await flamework("/api/flamework/mods/media/save", { gameId, modId: mod_id }).catch(() => {});
        return `Deleted image ${image_id}.`;
      }),
  );

  server.registerTool(
    "add_mod_video",
    {
      title: "Add Mod Video (author)",
      description: "Add a YouTube video to YOUR mod's Videos tab, as the mod editor does. Needs the author's web session.",
      inputSchema: {
        game,
        mod_id: modId,
        youtube_url: z.string().regex(YOUTUBE_RE, "Please enter a valid YouTube URL."),
        title: z.string().min(1),
        description: z.string().optional().default(""),
        dry_run: dryRunArg,
      },
      annotations: WRITE,
    },
    ({ game: g, mod_id, youtube_url, title, description, dry_run }) =>
      wrap("add_mod_video", async () => {
        const gameId = await resolveGameId(api, g);
        // postVideoAction("add", {description, gameId, modId, title, url}) → {success, videoId}.
        const body = { action: "add", description, gameId, modId: mod_id, title, url: youtube_url };
        if (dry_run) return dryRunReport("POST", `${WWW}/api/flamework/mods/media/videos`, body, "application/json");
        const j = await flamework("/api/flamework/mods/media/videos", body);
        if (!j.success) throw new Error("site answered success=false");
        await flamework("/api/flamework/mods/media/save", { gameId, modId: mod_id }).catch(() => {});
        return `Added video${j.videoId != null ? ` ${j.videoId}` : ""} to ${g}/${mod_id}.`;
      }),
  );

  server.registerTool(
    "delete_mod_video",
    {
      title: "Delete Mod Video (author)",
      description: "Delete a video from YOUR mod (video_id from add_mod_video / get_mod_media). Cannot be undone.",
      inputSchema: {
        game,
        mod_id: modId,
        video_id: z.number().int().positive(),
        video_type: z.number().int().optional().default(7).describe("videoObjectType; the editor defaults to 7"),
        dry_run: dryRunArg,
      },
      annotations: DESTRUCTIVE,
    },
    ({ game: g, mod_id, video_id, video_type, dry_run }) =>
      wrap("delete_mod_video", async () => {
        const gameId = await resolveGameId(api, g);
        // postVideoAction("delete", {gameId, modId, videoId, videoType}) in the mod editor.
        const body = { action: "delete", gameId, modId: mod_id, videoId: video_id, videoType: video_type };
        if (dry_run) return dryRunReport("POST", `${WWW}/api/flamework/mods/media/videos`, body, "application/json");
        const j = await flamework("/api/flamework/mods/media/videos", body);
        if (!j.success) throw new Error("site answered success=false");
        await flamework("/api/flamework/mods/media/save", { gameId, modId: mod_id }).catch(() => {});
        return `Deleted video ${video_id}.`;
      }),
  );

  // ── Mod page editing (General tab: name, summary, description, version) ──

  server.registerTool(
    "edit_mod_page",
    {
      title: "Edit Mod Page (author)",
      description:
        "Edit YOUR mod page's name, summary, full description (BBCode) and/or version, as the mod editor's Save does. Unchanged fields (category, author, tags, translation) are resent exactly as loaded. Omit all edit fields to just view the current values. Use dry_run to preview the request.",
      inputSchema: {
        game,
        mod_id: modId,
        name: z.string().min(1).max(250).optional(),
        summary: z.string().min(1).optional().describe("Short description"),
        description: z.string().min(1).optional().describe("Full description, BBCode"),
        version: z.string().regex(/^[a-zA-Z0-9.\-]+$/).max(255).optional(),
        dry_run: dryRunArg,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ game: g, mod_id, name, summary, description, version, dry_run }) =>
      wrap("edit_mod_page", async () => {
        const gameId = await resolveGameId(api, g);
        // Same loads as the editor: api-router Mod query + flamework settings.
        const d = await web.sessionGraphql<any>("Mod", MOD_EDIT_QUERY, { gameId: String(gameId), modId: String(mod_id) });
        const m = d.mod;
        if (!m) throw new Error(`mod ${g}/${mod_id} not found`);
        const s = await flameworkGet(`/api/flamework/mods/settings?gameId=${gameId}&modId=${mod_id}`);
        if (!s.permissions?.canEdit) throw new Error("this session cannot edit that mod (not author / team member)");
        const [curSummary, curDescription] = await web.evaluate(WWW, decodeBBCodeInPage, [m.summary ?? "", m.description ?? ""]);
        const edits = name !== undefined || summary !== undefined || description !== undefined || version !== undefined;
        if (!edits && !dry_run) {
          return truncate(
            [
              `${m.name} v${m.version} (${g}/${mod_id}) | category ${m.modCategory?.name ?? "?"} | author ${m.author ?? m.uploader?.name}`,
              `summary: ${curSummary}`,
              `description (BBCode, ${curDescription.length} chars):`,
              curDescription,
            ].join("\n"),
            20000,
          );
        }
        const tr = s.translation ?? { type: 1, language: 0, translationOf: 0 };
        // mapFormDataToSaveParams() of the mod editor.
        const payload: Record<string, unknown> = {
          modId: m.modId,
          gameId: Number(m.gameId),
          name: name ?? m.name,
          summary: (summary ?? curSummary).replace(/\n/g, "<br />") || "",
          description: description ?? curDescription,
          categoryId: m.modCategory ? Number(m.modCategory.categoryId) : 0,
          author: m.author ?? m.uploader?.name ?? "",
          version: version ?? (m.version || "1.0"),
          type: tr.type === 2 ? "2" : "1",
          languageId: Number(tr.language) || 0,
          ...(tr.type === 2 && tr.translationOf > 0 ? { originalModId: Number(tr.translationOf) } : {}),
          tags: (m.tags ?? []).map((t: any) => ({ id: String(t.id), selected: true })),
          classtags: (m.tags ?? []).map((t: any) => String(t.id)),
          saveAllTags: true,
        };
        const changed = [
          name !== undefined && name !== m.name ? "name" : "",
          summary !== undefined && summary !== curSummary ? "summary" : "",
          description !== undefined && description !== curDescription ? "description" : "",
          version !== undefined && version !== m.version ? "version" : "",
        ].filter(Boolean);
        if (dry_run) return `${dryRunReport("POST", `${WWW}/api/flamework/mods/save`, payload, "application/json")}\nchanged: ${changed.join(", ") || "nothing (identical save)"}`;
        const j = await flamework("/api/flamework/mods/save", payload);
        if (!j.success) throw new Error("site answered success=false");
        return `Saved ${g}/${mod_id} (changed: ${changed.join(", ") || "nothing — identical save"}).`;
      }),
  );
}
