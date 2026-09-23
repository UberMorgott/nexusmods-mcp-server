# nexusmods-mcp-server

## Overview
MCP server for Nexus Mods (any game). 39 tools: v1 REST, v2 GraphQL, v3 uploads, plus a
browser-session web tier (mod comments, forums, collection comment writes).
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
- `src/clients/browser-client.ts` — patchright persistent context, headless with UA `HeadlessChrome`→`Chrome` via CDP; one page per origin (www, forums); visible only for login / `NEXUS_BROWSER_VISIBLE=1`.
- `src/clients/web-client.ts` — cookies (`.auth/cookies.json`), login (rookie extract → visible sign-in), api-router GraphQL with session, form posts.
- `src/clients/site-parsers.ts` — runs INSIDE the page (page.evaluate): fetch + DOMParser. Must stay self-contained.
- `src/tools/{rest-api,graphql-api,upload-api,web-api}.ts` — tool registration. `src/server.ts` — assembly + `buildInstructions`.

## Conventions
- NEVER write to stdout (stdout = JSON-RPC). Log via console.error.
- `import { z } from "zod/v4"`; every tool has `annotations`; handlers return `success()`/`error()`; compact text output.
- Every Nexus API request sends `Application-Name` + `Application-Version`.
- Web-tier tools only for requests the site itself makes; record evidence/TODO in `docs/web-endpoints.md`. No guessed endpoints.
- `docs/research.md` = API source of truth. v3 upload flow = official `Nexus-Mods/upload-action` schema.
- Do not copy code from PHLemp/nexus-mods-mcp (no license).
- License CC BY-NC 4.0, header `Copyright (c) 2026 Morgott`.

## Testing
```bash
npx @modelcontextprotocol/inspector node build/index.js
```
Never post/upload/send on Nexus while testing.
