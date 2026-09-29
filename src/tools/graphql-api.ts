// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { NexusApiClient } from "../clients/nexus-api.js";
import { success, error, errMsg } from "../utils/types.js";
import { fmtDate, fmtNum, oneLine, truncate, stripHtml } from "../utils/helpers.js";
import { formatArg, jsonResult, jsonError } from "../utils/structured.js";
import { modsJson } from "./json-shapes.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const game = z.string().min(1).describe('Game domain name, e.g. "skyrimspecialedition"');

const gameIdCache = new Map<string, number>();

/** Game domain → numeric game id (public GraphQL, cached). */
export async function resolveGameId(api: NexusApiClient, domain: string): Promise<number> {
  const hit = gameIdCache.get(domain);
  if (hit) return hit;
  const d = await api.graphql<{ game: { id: number } | null }>(
    "query($d:String){ game(domainName:$d){ id } }",
    { d: domain },
  );
  if (!d.game) throw new Error(`Unknown game domain "${domain}" (use list_games)`);
  gameIdCache.set(domain, d.game.id);
  return d.game.id;
}

const SORT_FIELDS = ["relevance", "downloads", "endorsements", "updatedAt", "createdAt", "name"] as const;

function formatGqlMod(m: any): string {
  let line = `[${m.game?.domainName}/${m.modId}] ${m.name} v${m.version ?? "?"} — ${fmtNum(m.downloads)} dl, ${fmtNum(m.endorsements)} end | by ${m.author ?? m.uploader?.name ?? "?"} | upd ${fmtDate(m.updatedAt)}`;
  if (m.summary) line += `\n  ${oneLine(m.summary, 200)}`;
  return line;
}

function formatComment(c: any, indent = ""): string {
  const flags = [c.isPinned ? "pinned" : "", c.likesCount ? `${c.likesCount} likes` : ""].filter(Boolean).join(", ");
  return `${indent}[${c.id}] ${c.creator?.name ?? "?"} (${fmtDate(c.createdAt)}${flags ? `, ${flags}` : ""}): ${oneLine(stripHtml(c.body ?? ""), 400)}`;
}

export function registerGraphqlTools(server: McpServer, api: NexusApiClient): void {
  const wrap = (name: string, fn: () => Promise<string>) => fn().then(success, (e) => error(`${name}: ${errMsg(e)}`));

  server.registerTool(
    "search_mods",
    {
      title: "Search Mods (GraphQL)",
      description:
        "Search mods by name (wildcard), optionally within one game, sorted. No API key needed. Returns game/modId pairs usable by every other tool.",
      inputSchema: {
        query: z.string().optional().describe("Text to find in the mod name"),
        game: game.optional(),
        author: z.string().optional().describe("Exact author name"),
        sort: z.enum(SORT_FIELDS).optional().default("relevance"),
        direction: z.enum(["DESC", "ASC"]).optional().default("DESC"),
        count: z.number().int().min(1).max(50).optional().default(10),
        offset: z.number().int().min(0).optional().default(0),
        include_adult: z.boolean().optional().default(false),
        format: formatArg,
      },
      annotations: READ,
    },
    ({ query, game: g, author, sort, direction, count, offset, include_adult, format }) => {
      const run = (fields: string) => {
        const filter: Record<string, unknown> = {};
        if (query) filter.name = [{ value: query, op: "WILDCARD" }];
        if (g) filter.gameDomainName = [{ value: g, op: "EQUALS" }];
        if (author) filter.author = [{ value: author, op: "EQUALS" }];
        if (!include_adult) filter.adultContent = [{ value: false, op: "EQUALS" }];
        const sortKey = sort === "name" ? "name" : sort;
        return api.graphql(
          `query($f:ModsFilter,$s:[ModsSort!],$c:Int,$o:Int){ mods(filter:$f, sort:$s, count:$c, offset:$o){ totalCount nodes{ ${fields} } } }`,
          { f: filter, s: [{ [sortKey]: { direction } }], c: count, o: offset },
        );
      };
      if (format === "json")
        return run("modId uid name version author summary downloads endorsements createdAt updatedAt uploader{ name memberId } game{ domainName }").then(
          (d) => jsonResult(modsJson(d.mods, offset, count)),
          (e) => jsonError("search_mods", e),
        );
      return wrap("search_mods", async () => {
        const d = await run("modId name version author summary downloads endorsements updatedAt game{ domainName }");
        const nodes: any[] = d.mods.nodes;
        return `${d.mods.totalCount} matches (showing ${offset + 1}-${offset + nodes.length}):\n${nodes.map(formatGqlMod).join("\n")}`;
      });
    },
  );

  server.registerTool(
    "list_games",
    {
      title: "List / Find Games (GraphQL)",
      description: "Find games and their domain names (needed by all game-scoped tools). No API key needed.",
      inputSchema: {
        query: z.string().optional().describe("Part of the game name"),
        count: z.number().int().min(1).max(100).optional().default(20),
      },
      annotations: READ,
    },
    ({ query, count }) =>
      wrap("list_games", async () => {
        const filter = query ? { name: [{ value: query, op: "WILDCARD" }] } : undefined;
        const d = await api.graphql(
          `query($f:GamesSearchFilter,$c:Int){ games(filter:$f, sort:[{downloads:{direction:DESC}}], count:$c){ totalCount nodes{ id name domainName modCount collectionCount } } }`,
          { f: filter, c: count },
        );
        return d.games.nodes.map((g: any) => `${g.domainName} — ${g.name} (id ${g.id}, ${fmtNum(g.modCount)} mods, ${fmtNum(g.collectionCount)} collections)`).join("\n");
      }),
  );

  server.registerTool(
    "get_mod_details",
    {
      title: "Get Mod Details + Description + Requirements (GraphQL)",
      description:
        "Mod info without an API key, including the full description (BBCode as stored), tags, uid (for v3), requirements and mods requiring it.",
      inputSchema: {
        game,
        mod_id: z.number().int().positive(),
        include_description: z.boolean().optional().default(true),
      },
      annotations: READ,
    },
    ({ game: g, mod_id, include_description }) =>
      wrap("get_mod_details", async () => {
        const d = await api.graphql(
          `query($ids:[CompositeDomainWithIdInput!]!){ legacyModsByDomain(ids:$ids){ nodes{ uid modId name version author status summary description downloads endorsements createdAt updatedAt adultContent category game{ domainName id } uploader{ name memberId } tags{ name } modRequirements{ nexusRequirements{ totalCount nodes{ modId modName url notes externalRequirement } } dlcRequirements{ __typename } modsRequiringThisMod(count:20){ totalCount nodes{ modId modName } } } } } }`,
          { ids: [{ gameDomain: g, modId: mod_id }] },
        );
        const m = d.legacyModsByDomain.nodes[0];
        if (!m) return `No mod ${g}/${mod_id}`;
        const req = m.modRequirements;
        const lines = [
          `${m.name} [${m.game.domainName}/${m.modId}] v${m.version} | uid ${m.uid} | game id ${m.game.id}`,
          `by ${m.author} (uploader ${m.uploader?.name} #${m.uploader?.memberId}) | status ${m.status} | category ${m.category}${m.adultContent ? " | adult" : ""}`,
          `downloads ${fmtNum(m.downloads)} | endorsements ${fmtNum(m.endorsements)} | created ${fmtDate(m.createdAt)} | updated ${fmtDate(m.updatedAt)}`,
          `summary: ${oneLine(m.summary, 400)}`,
        ];
        if (m.tags?.length) lines.push(`tags: ${m.tags.map((t: any) => t.name).join(", ")}`);
        if (req?.nexusRequirements?.totalCount) {
          lines.push(`requires (${req.nexusRequirements.totalCount}): ${req.nexusRequirements.nodes.map((r: any) => `${r.modName} [${r.externalRequirement ? r.url : r.modId}]${r.notes ? ` (${oneLine(r.notes, 80)})` : ""}`).join("; ")}`);
        }
        if (req?.modsRequiringThisMod?.totalCount) {
          lines.push(`required by ${req.modsRequiringThisMod.totalCount} mods, e.g.: ${req.modsRequiringThisMod.nodes.map((r: any) => `${r.modName} [${r.modId}]`).join("; ")}`);
        }
        if (include_description) lines.push(`\ndescription:\n${m.description}`);
        return truncate(lines.join("\n"), 30000);
      }),
  );

  server.registerTool(
    "search_collections",
    {
      title: "Search Collections (GraphQL)",
      description: "Search collections by name / game. Returns slugs for get_collection and get_collection_comments.",
      inputSchema: {
        query: z.string().optional(),
        game: game.optional(),
        sort: z.enum(["endorsements", "downloads", "updatedAt", "createdAt", "rating"]).optional().default("endorsements"),
        count: z.number().int().min(1).max(50).optional().default(10),
        offset: z.number().int().min(0).optional().default(0),
      },
      annotations: READ,
    },
    ({ query, game: g, sort, count, offset }) =>
      wrap("search_collections", async () => {
        const filter: Record<string, unknown> = {};
        if (query) filter.name = [{ value: query, op: "WILDCARD" }];
        if (g) filter.gameDomain = [{ value: g, op: "EQUALS" }];
        const d = await api.graphql(
          `query($f:CollectionsSearchFilter,$s:[CollectionsSearchSort!],$c:Int,$o:Int){ collectionsV2(filter:$f, sort:$s, count:$c, offset:$o){ totalCount nodes{ slug name summary endorsements totalDownloads game{ domainName } user{ name } latestPublishedRevision{ revisionNumber modCount } } } }`,
          { f: filter, s: [{ [sort]: { direction: "DESC" } }], c: count, o: offset },
        );
        const nodes: any[] = d.collectionsV2.nodes;
        return `${d.collectionsV2.totalCount} collections:\n${nodes
          .map((c) => `[${c.game.domainName}/${c.slug}] ${c.name} by ${c.user?.name} — rev ${c.latestPublishedRevision?.revisionNumber ?? "?"}, ${c.latestPublishedRevision?.modCount ?? "?"} mods, ${fmtNum(c.endorsements)} end, ${fmtNum(c.totalDownloads)} dl\n  ${oneLine(c.summary, 160)}`)
          .join("\n")}`;
      }),
  );

  server.registerTool(
    "get_collection",
    {
      title: "Get Collection (GraphQL)",
      description: "Collection details by slug: author, stats, comment thread id, latest revision and (optionally) its mod list.",
      inputSchema: {
        slug: z.string().describe("Collection slug from the URL /<game>/collections/<slug>"),
        game: game.optional(),
        list_mods: z.boolean().optional().default(true),
      },
      annotations: READ,
    },
    ({ slug, game: g, list_mods }) =>
      wrap("get_collection", async () => {
        const d = await api.graphql(
          `query($s:String,$g:String){ collection(slug:$s, domainName:$g){ id slug name summary endorsements totalDownloads createdAt updatedAt game{ domainName } user{ name } commentThread{ id } latestPublishedRevision{ revisionNumber modCount totalSize ${list_mods ? "modFiles{ optional file{ name version modId fileId mod{ name } } }" : ""} } } }`,
          { s: slug, g },
        );
        const c = d.collection;
        const rev = c.latestPublishedRevision;
        const lines = [
          `${c.name} [${c.game.domainName}/${c.slug}] by ${c.user?.name} | id ${c.id} | comment thread ${c.commentThread?.id}`,
          `endorsements ${fmtNum(c.endorsements)} | downloads ${fmtNum(c.totalDownloads)} | created ${fmtDate(c.createdAt)} | updated ${fmtDate(c.updatedAt)}`,
          `summary: ${oneLine(c.summary, 400)}`,
        ];
        if (rev) lines.push(`latest revision ${rev.revisionNumber}: ${rev.modCount} mods`);
        if (list_mods && rev?.modFiles) {
          lines.push(
            ...rev.modFiles.map((mf: any) => `  ${mf.file?.mod?.name ?? "?"} [${mf.file?.modId}] file ${mf.file?.fileId} ${mf.file?.version ?? ""}${mf.optional ? " (optional)" : ""}`),
          );
        }
        return truncate(lines.join("\n"));
      }),
  );

  server.registerTool(
    "get_collection_comments",
    {
      title: "Get Collection Comments (GraphQL)",
      description:
        "Read a collection's comments (newest first) with first replies. Pass comment_thread_id (from get_collection) or slug. Paginate with `after` = endCursor. Write via post_collection_comment (web tier).",
      inputSchema: {
        comment_thread_id: z.string().optional(),
        slug: z.string().optional(),
        game: game.optional(),
        first: z.number().int().min(1).max(50).optional().default(20),
        after: z.string().optional().describe("Cursor from a previous page"),
      },
      annotations: READ,
    },
    ({ comment_thread_id, slug, game: g, first, after }) =>
      wrap("get_collection_comments", async () => {
        let threadId = comment_thread_id;
        if (!threadId) {
          if (!slug) throw new Error("pass comment_thread_id or slug");
          const c = await api.graphql(`query($s:String,$g:String){ collection(slug:$s, domainName:$g){ commentThread{ id } } }`, { s: slug, g });
          threadId = c.collection.commentThread.id;
        }
        const d = await api.graphql(
          `query($t:ID!,$f:Int,$a:String){ commentThread(commentThreadId:$t){ id comments(first:$f, after:$a){ totalCount pageInfo{ endCursor hasNextPage } nodes{ id body createdAt likesCount isPinned creator{ name } replies(first:5){ totalCount nodes{ id body createdAt likesCount creator{ name } } } } } } }`,
          { t: threadId, f: first, a: after },
        );
        const conn = d.commentThread.comments;
        const out = [`thread ${threadId}: ${conn.totalCount} comments${conn.pageInfo.hasNextPage ? ` (next: after="${conn.pageInfo.endCursor}")` : ""}`];
        for (const c of conn.nodes) {
          out.push(formatComment(c));
          for (const r of c.replies?.nodes ?? []) out.push(formatComment(r, "  └─ "));
          if (c.replies?.totalCount > (c.replies?.nodes?.length ?? 0)) out.push(`  └─ … ${c.replies.totalCount - c.replies.nodes.length} more replies`);
        }
        return truncate(out.join("\n"));
      }),
  );

  server.registerTool(
    "get_user",
    {
      title: "Get User (GraphQL)",
      description: "Public profile by username: member id, join date, kudos, mod/collection counts, about.",
      inputSchema: { name: z.string().min(1) },
      annotations: READ,
    },
    ({ name }) =>
      wrap("get_user", async () => {
        const d = await api.graphql(
          `query($n:String!){ userByName(name:$n){ memberId name joined lastActive kudos posts modCount collectionCount uniqueModDownloads recognizedAuthor about } }`,
          { n: name },
        );
        const u = d.userByName;
        if (!u) return `No user "${name}"`;
        return [
          `${u.name} (member ${u.memberId}) | joined ${fmtDate(u.joined)} | last active ${fmtDate(u.lastActive)}${u.recognizedAuthor ? " | recognized author" : ""}`,
          `kudos ${u.kudos} | posts ${u.posts} | mods ${u.modCount} | collections ${u.collectionCount} | unique mod downloads ${fmtNum(u.uniqueModDownloads)}`,
          u.about ? `about: ${oneLine(stripHtml(u.about), 500)}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }),
  );

  server.registerTool(
    "get_news",
    {
      title: "Get News (GraphQL)",
      description: "Latest Nexus Mods news, optionally per game/category.",
      inputSchema: {
        game: game.optional(),
        category: z.enum(["SITE_NEWS", "GAME_NEWS", "MOD_NEWS", "INTERVIEWS", "COMPETITIONS", "FEATURES"]).optional(),
        count: z.number().int().min(1).max(30).optional().default(10),
      },
      annotations: READ,
    },
    ({ game: g, category, count }) =>
      wrap("get_news", async () => {
        const gameId = g ? await resolveGameId(api, g) : undefined;
        const d = await api.graphql(
          `query($c:NewsCategoryEnum,$g:Int,$n:Int){ news(newsCategory:$c, gameId:$g, count:$n){ nodes{ id title date summary author{ name } } } }`,
          { c: category, g: gameId, n: count },
        );
        return d.news.nodes.map((n: any) => `[${n.id}] ${fmtDate(n.date)} ${n.title} (${n.author?.name})\n  ${oneLine(stripHtml(n.summary), 200)}`).join("\n");
      }),
  );

  server.registerTool(
    "graphql_query",
    {
      title: "Raw GraphQL Query (read-only)",
      description:
        "Run any read-only query against https://api.nexusmods.com/v2/graphql (schema: https://graphql.nexusmods.com/). Mutations are rejected. Output is raw JSON — prefer the typed tools.",
      inputSchema: {
        query: z.string().min(1),
        variables: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: READ,
    },
    ({ query, variables }) =>
      wrap("graphql_query", async () => {
        if (/^\s*(mutation|subscription)\b/i.test(query) || /\bmutation\s*[({]/i.test(query)) {
          throw new Error("only read queries are allowed");
        }
        return truncate(JSON.stringify(await api.graphql(query, variables)));
      }),
  );
}
