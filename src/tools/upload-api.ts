// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

// v3 upload flow, per the official OpenAPI schema used by Nexus-Mods/upload-action:
//   POST /uploads/multipart → PUT each part_presigned_url (collect ETag) → POST complete_presigned_url (XML)
//   → POST /uploads/{id}/finalise → poll GET /uploads/{id} until state=available
//   → POST /mod-files/{mod_file_id}/versions → optional POST /mods/{mod_uid}/changelogs

import { statSync, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { Config } from "../config.js";
import type { NexusApiClient } from "../clients/nexus-api.js";
import { success, error, errMsg } from "../utils/types.js";
import { fmtDate, fmtSize, isWithinDir } from "../utils/helpers.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const PART_CONCURRENCY = 4;

async function uploadMultipart(api: NexusApiClient, filePath: string): Promise<string> {
  const size = statSync(filePath).size;
  const { data } = await api.v3("POST", "/uploads/multipart", {
    filename: path.basename(filePath),
    size_bytes: String(size),
  });
  const { id, part_presigned_urls: urls, part_size_bytes: partSize, complete_presigned_url: completeUrl } = data;
  console.error(`[upload] ${id}: ${urls.length} parts of ${partSize} bytes`);

  const fh = await open(filePath, "r");
  const etags: string[] = new Array(urls.length);
  try {
    for (let i = 0; i < urls.length; i += PART_CONCURRENCY) {
      await Promise.all(
        urls.slice(i, i + PART_CONCURRENCY).map(async (url: string, j: number) => {
          const idx = i + j;
          const buf = Buffer.alloc(partSize);
          const { bytesRead } = await fh.read(buf, 0, partSize, idx * partSize);
          const res = await api.storage(url, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytesRead) },
            body: buf.subarray(0, bytesRead),
          });
          const etag = res.headers.get("ETag");
          if (!etag) throw new Error(`no ETag for part ${idx + 1}`);
          etags[idx] = etag.replace(/"/g, "");
        }),
      );
    }
  } finally {
    await fh.close();
  }

  const xml =
    "<CompleteMultipartUpload>\n" +
    etags.map((e, i) => `  <Part>\n    <PartNumber>${i + 1}</PartNumber>\n    <ETag>${e}</ETag>\n  </Part>`).join("\n") +
    "\n</CompleteMultipartUpload>";
  await api.storage(completeUrl, { method: "POST", headers: { "Content-Type": "application/xml" }, body: xml });

  await api.v3("POST", `/uploads/${id}/finalise`);
  for (let attempt = 0; attempt < 60; attempt++) {
    const { data: up } = await api.v3("GET", `/uploads/${id}`);
    if (up.state === "available") return id;
    await new Promise((r) => setTimeout(r, Math.min(2000 * Math.pow(1.5, attempt), 30000)));
  }
  throw new Error(`upload ${id} not available after polling; retry publish later with upload_id="${id}"`);
}

export function registerUploadTools(server: McpServer, api: NexusApiClient, config: Config): void {
  const wrap = (name: string, fn: () => Promise<string>) => fn().then(success, (e) => error(`${name}: ${errMsg(e)}`));

  server.registerTool(
    "get_upload_targets",
    {
      title: "Get Mod Upload Targets (v3)",
      description:
        "Resolve a mod (game + mod_id from the site URL) to its v3 mod uid and list its mod files (v3 mod_file ids) — the ids upload_file_version and add_changelog need.",
      inputSchema: { game: z.string().min(1), mod_id: z.number().int().positive() },
      annotations: READ,
    },
    ({ game, mod_id }) =>
      wrap("get_upload_targets", async () => {
        const { data: mod } = await api.v3("GET", `/games/${encodeURIComponent(game)}/mods/${mod_id}`);
        const { data: files } = await api.v3("GET", `/mods/${mod.id}/files`);
        const rows = (files.mod_files ?? []).map(
          (f: any) =>
            `  mod_file ${f.id}: ${f.name} | ${f.is_active ? "active" : "inactive"} | ${f.versions_count} versions (${f.archived_count} archived) | last upload ${fmtDate(f.last_file_uploaded_at)}`,
        );
        return `${mod.name ?? "?"} — v3 mod uid ${mod.id} (game ${mod.game_id}, site id ${mod.game_scoped_id})\n${rows.join("\n") || "  (no mod files — create the first file on the website)"}`;
      }),
  );

  server.registerTool(
    "get_mod_file_versions",
    {
      title: "List Mod File Versions (v3)",
      description: "Versions of one v3 mod file (id, version, category, upload date, primary).",
      inputSchema: { mod_file_id: z.string().min(1).describe("v3 mod_file id from get_upload_targets") },
      annotations: READ,
    },
    ({ mod_file_id }) =>
      wrap("get_mod_file_versions", async () => {
        const { data } = await api.v3("GET", `/mod-files/${encodeURIComponent(mod_file_id)}/versions`);
        return (data.versions ?? [])
          .map((v: any) => `${v.id} (site file ${v.game_scoped_id}): ${v.name} v${v.version} [${v.category}] ${fmtDate(v.uploaded_at)}${v.is_primary ? " primary" : ""}`)
          .join("\n");
      }),
  );

  server.registerTool(
    "upload_file_version",
    {
      title: "Upload New File Version (v3)",
      description:
        "Upload a local archive as a NEW VERSION of an existing mod file and publish it immediately (multipart upload → finalise → wait → publish). " +
        "Get mod_file_id from get_upload_targets. If publishing fails after the upload, retry with upload_id to skip re-uploading. Optionally adds a changelog (needs mod_uid).",
      inputSchema: {
        mod_file_id: z.string().min(1).describe("v3 mod_file id to add the version to"),
        file_path: z.string().optional().describe("Absolute path of the archive to upload (omit when passing upload_id)"),
        upload_id: z.string().optional().describe("Reuse an already-available upload instead of uploading file_path"),
        version: z.string().min(1).describe("Version string, e.g. 1.2.0"),
        name: z.string().optional().describe("Display name (defaults to the file name)"),
        description: z.string().optional(),
        file_category: z.enum(["main", "optional", "miscellaneous"]).optional().default("main"),
        archive_existing_file: z.boolean().optional().default(false).describe("Archive the previous version"),
        update_mod_version: z.boolean().optional().default(false).describe("Set the mod's version to this version"),
        primary_mod_manager_download: z.boolean().optional(),
        allow_mod_manager_download: z.boolean().optional(),
        show_requirements_pop_up: z.boolean().optional(),
        previous_version_id: z.string().optional().describe("v3 version id this replaces"),
        changelog: z.string().optional().describe("Changelog text for this version (requires mod_uid)"),
        mod_uid: z.string().optional().describe("v3 mod uid (from get_upload_targets), needed for changelog"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) => {
      try {
        if (a.changelog && !a.mod_uid) return error("upload_file_version: changelog requires mod_uid");
        let uploadId = a.upload_id;
        let fileName = a.name;
        if (!uploadId) {
          if (!a.file_path) return error("upload_file_version: pass file_path or upload_id");
          const fp = path.resolve(a.file_path);
          if (config.uploadDir && !isWithinDir(config.uploadDir, fp)) {
            return error(`upload_file_version: ${fp} is outside NEXUS_UPLOAD_DIR (${config.uploadDir})`);
          }
          if (!existsSync(fp) || !statSync(fp).isFile()) return error(`upload_file_version: file not found: ${fp}`);
          fileName ??= path.basename(fp);
          console.error(`[upload] uploading ${fp} (${fmtSize(statSync(fp).size)})`);
          uploadId = await uploadMultipart(api, fp);
        }
        const body: Record<string, unknown> = {
          upload_id: uploadId,
          name: fileName ?? a.version,
          description: a.description,
          version: a.version,
          file_category: a.file_category,
          archive_existing_file: a.archive_existing_file,
          update_mod_version: a.update_mod_version,
          primary_mod_manager_download: a.primary_mod_manager_download,
          allow_mod_manager_download: a.allow_mod_manager_download,
          show_requirements_pop_up: a.show_requirements_pop_up,
          previous_version_id: a.previous_version_id,
        };
        let published: any;
        try {
          published = (await api.v3("POST", `/mod-files/${encodeURIComponent(a.mod_file_id)}/versions`, body)).data;
        } catch (e) {
          return error(`upload_file_version: bytes uploaded (upload_id="${uploadId}") but publish failed — fix and retry with upload_id. ${errMsg(e)}`);
        }
        let out = `Published version ${a.version}: version id ${published.version?.id} in mod_file ${published.file?.id} (${published.file?.name}, ${published.file?.file_category})`;
        if (a.changelog && a.mod_uid) {
          try {
            await api.v3("POST", `/mods/${encodeURIComponent(a.mod_uid)}/changelogs`, { version: a.version, changelog: a.changelog });
            out += "\nChangelog added.";
          } catch (e) {
            out += `\nChangelog FAILED (retry with add_changelog): ${errMsg(e)}`;
          }
        }
        return success(out);
      } catch (e) {
        return error(`upload_file_version: ${errMsg(e)}`);
      }
    },
  );

  server.registerTool(
    "add_changelog",
    {
      title: "Add Changelog Entry (v3)",
      description: "Add changelog text for a version of a mod. mod_uid from get_upload_targets.",
      inputSchema: {
        mod_uid: z.string().min(1),
        version: z.string().min(1),
        changelog: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ mod_uid, version, changelog }) =>
      wrap("add_changelog", async () => {
        const { data } = await api.v3("POST", `/mods/${encodeURIComponent(mod_uid)}/changelogs`, { version, changelog });
        return `Changelog added for ${data.version ?? version}.`;
      }),
  );
}
