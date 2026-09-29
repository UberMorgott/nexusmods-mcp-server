# nexusmods-mcp-server

## Overview
MCP server for Nexus Mods (any game). 59 tools: v1 REST, v2 GraphQL, v3 uploads, plus a
browser-session web tier (mod comments, bug reports, forums + replies, private messages,
collection comment writes, author tools: page edit, media, comment hiding).
Sibling/architecture model: `E:\DEV\curseforge`.

## Build & Run
```bash
npm install
npm run build      # tsc → build/
npm start          # stdio server
npm run dev        # tsx watch
npm run setup      # wizard: API key, web session
```

## Architecture
- `src/clients/nexus-api.ts` — native fetch; v1 `api.nexusmods.com/v1`, v2 GraphQL `/v2/graphql` (reads work keyless), v3 `/v3`. Tracks `x-rl-*-remaining`.
- `src/clients/browser-client.ts` — patchright persistent context, headless with UA `HeadlessChrome`→`Chrome` via CDP; one page per origin (www, forums); visible only for login / `NEXUS_BROWSER_VISIBLE=1`. Login runs in its own tab — never park a pooled page off its origin (in-page fetch → CORS "Failed to fetch").
- `src/clients/web-client.ts` — cookies (`.auth/cookies.json`), login (rookie extract → visible sign-in), api-router GraphQL with session, form posts, `submit()` (form/multipart/JSON from the page), forum SSO (`ensureForumSession`: forums `/login/` signs in silently).
- `src/clients/site-parsers.ts` — runs INSIDE the page (page.evaluate): fetch + DOMParser, `submitRequest`. Must stay self-contained. Form serializing skips `<noscript>` controls (DOMParser has scripting off; Invision's `_noscript` editor twin would override the real field).
- `src/tools/{rest-api,graphql-api,upload-api,web-api,web-mod}.ts` — tool registration (`web-api`: session, comments, forums, PMs; `web-mod`: bugs, media, page edit, comment hiding). `src/server.ts` — assembly + `buildInstructions`.

## Conventions
- NEVER write to stdout (stdout = JSON-RPC). Log via console.error.
- `import { z } from "zod/v4"`; every tool has `annotations`; handlers return `success()`/`error()`; compact text output. Machine output = opt-in `format: "json"` (`src/utils/structured.ts`, shapes in `src/tools/json-shapes.ts`, README → Structured output); text stays default and unchanged.
- Every Nexus API request sends `Application-Name` + `Application-Version`.
- Web-tier tools only for requests the site itself makes; record evidence/TODO in `docs/web-endpoints.md`. No guessed endpoints.
- `docs/research.md` = API source of truth. v3 upload flow = official `Nexus-Mods/upload-action` schema.
- Do not copy code from PHLemp/nexus-mods-mcp (no license).
- License CC BY-NC 4.0, header `Copyright (c) 2026 Morgott`.

## Testing
```bash
npm test   # fixture tests (test/fixtures = saved site widgets, anonymized), no network
npx @modelcontextprotocol/inspector node build/index.js
```
Never post/upload/send on Nexus while testing unless the user approves; use `dry_run: true`
(every web write has it). Approved live tests: own content only, clean up after (PM to self →
`pm_leave`; comment on own mod → `hide_mod_comment`; image/video → delete; bug → `delete_mod_bug`).
Own test targets: user UberMorgott (member 6541781), mod `windrose/147`.
