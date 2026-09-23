# Nexus Mods Programmatic Access — Research (2026-09-23)

## 1. Authentication

### Personal API Key
- Generated at https://www.nexusmods.com/settings/api-keys
- Sent as HTTP header: `apikey: <key>`
- For personal/testing use only; public apps must register
- Source: https://help.nexusmods.com/article/114-api-acceptable-use-policy

### WebSocket SSO (Legacy/Desktop Apps)
- Connect: `wss://sso.nexusmods.com`
- Send: `{"id": "<uuid>", "token": null, "protocol": 2}`
- Open browser: `https://www.nexusmods.com/sso?id=<uuid>&application=<app_slug>`
- User authorizes; server sends `{"success": true, "data": {"api_key": "..."}, "error": null}`
- On connect, server first sends `{"success": true, "data": {"connection_token": "..."}, "error": null}`
- Must send WebSocket ping every 30s until connection closes
- Reconnect with `"token": "<connection_token>"` from initial ack
- Application slug obtained from Nexus Mods staff (no self-service)
- Returns a **personal API key**, not an OAuth token
- Source: https://github.com/Nexus-Mods/sso-integration-demo

### OAuth 2.0 (PKCE, Newer)
- Well-known: `https://users.nexusmods.com/.well-known/openid-configuration`
- Authorization: `https://users.nexusmods.com/oauth/authorize`
- Token: `https://users.nexusmods.com/oauth/token`
- Userinfo: `https://users.nexusmods.com/oauth/userinfo`
- JWKS: `https://users.nexusmods.com/oauth/discovery/keys`
- Scopes: `public`, `openid`, `mod_file:quarantine`
- Response types: `code`, `token`, `id_token`, `id_token token`
- Grant types: `authorization_code`, `implicit_oidc`, `client_credentials`, `refresh_token`
- PKCE S256; **no client secret** (public client)
- No self-service app registration — email `support@nexusmods.com` with: app name, description, logo, source link, callback URI to receive `client_id`
- Required for v2 GraphQL mutations and v3 Upload API
- Source: https://users.nexusmods.com/.well-known/openid-configuration

### App Registration
- Public apps MUST register with Nexus Mods
- Contact support with testing build, app name, description, logo
- Receive an app "slug" for SSO and a `client_id` for OAuth
- Nexus Mods may deny registration for closed-source or non-compliant apps
- Open source strongly encouraged

### Rate Limits
- **Daily**: 20,000 requests per 24h (resets 00:00 GMT)
- **Hourly**: 500 requests per hour (resets on the hour)
- Limits sent in response headers on every request
- `node-nexus-api` exposes: `DailyRemaining`, `DailyLimit`, `HourlyRemaining`, `HourlyLimit`
- No documented premium vs free difference in limits
- Source: https://help.nexusmods.com/article/105-i-have-reached-a-daily-or-hourly-limit-api-requests-have-been-consumed-rate-limit-exceeded-what-does-this-mean

### Required Request Headers
- `apikey` — the API key
- `Application-Name` — consistent app identifier (e.g. "Vortex")
- `Application-Version` — current release number (e.g. "1.2.0")
- Source: https://help.nexusmods.com/article/114-api-acceptable-use-policy

---

## 2. REST API v1 (`api.nexusmods.com/v1`)

Base URL: `https://api.nexusmods.com/v1`
Auth: `apikey` header
Docs: https://api-docs.nexusmods.com/

### Endpoints (from `node-nexus-api` source at https://github.com/Nexus-Mods/node-nexus-api)

#### Games
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/games` | List all supported games |
| GET | `/v1/games/{game_domain_name}` | Get game details |

#### Mods
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/games/{game}/mods/{id}` | Get mod details |
| GET | `/v1/games/{game}/mods/latest_added` | Recently added mods |
| GET | `/v1/games/{game}/mods/latest_updated` | Recently updated mods |
| GET | `/v1/games/{game}/mods/trending` | Trending mods |
| GET | `/v1/games/{game}/mods/updated?period={period}` | Mods updated in period (1d/1w/1m) |
| GET | `/v1/games/{game}/mods/md5_search/{hash}` | Find mod file by MD5 |

#### Mod Files
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/games/{game}/mods/{id}/files` | List all files for mod |
| GET | `/v1/games/{game}/mods/{id}/files/{file_id}` | Get file details |
| GET | `/v1/games/{game}/mods/{id}/files/{file_id}/download_link` | Generate download link (premium: direct; free: needs `key` + `expires` from NXM link) |

#### Changelogs
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/games/{game}/mods/{id}/changelogs` | Get all version changelogs |

#### Endorsements
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/games/{game}/mods/{id}/endorse` | Endorse a mod |
| POST | `/v1/games/{game}/mods/{id}/abstain` | Abstain from endorsing |
| GET | `/v1/user/endorsements` | List user's endorsements |

#### Tracked Mods
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/user/tracked_mods` | List tracked mods |
| POST | `/v1/user/tracked_mods` | Track a mod (body: `domain_name`, `mod_id`) |
| DELETE | `/v1/user/tracked_mods` | Untrack a mod |

#### User
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/users/validate` | Validate API key, return user info |

#### Misc
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/colourschemes` | Available color schemes |

### Download Links — Premium vs Free
- **Premium**: `GET .../download_link` returns direct CDN URLs, no extra params
- **Free**: Requires `key` and `expires` query params extracted from NXM protocol link (`nxm://...?key=X&expires=Y`); user must click "Download with Manager" on web page to generate these
- NXM link format: `nxm://{game_domain}/mods/{mod_id}/files/{file_id}?key=xxx&expires=xxx`

---

## 3. GraphQL API v2 (`api.nexusmods.com/v2/graphql`)

- Endpoint: `POST https://api.nexusmods.com/v2/graphql`
- Auth: `apikey` header for most queries; OAuth token required for mutations
- Docs: https://graphql.nexusmods.com/
- Status: **active development** — breaking changes possible ("may change, evolve, or even disappear without warning")
- Schema introspection: enabled (`__schema` queries work)
- Context7: https://context7.com/websites/graphql_nexusmods (140k tokens, 1122 snippets)

### Queries (~50+)

**Mods & Files:**
- `mod`, `mods`, `modsByUid`, `legacyMods`, `legacyModsByDomain`
- `modFiles`, `modFilesByUid`, `modFileContents`
- `fileHash`, `fileHashes` (MD5 lookup)
- `modEndorsers`

**Collections:**
- `collection`, `collectionsV2`, `myCollections`
- `collectionGames`, `collectionRevision`
- `collectionRevisionUploadUrl` (presigned URL for collection packages)

**Comments:**
- `comment` — single comment by ID
- `commentThread` — full thread by ID
- `searchComments` — search with filters/sorting and pagination

**Users:**
- `user`, `userByName`, `users`
- `ignoredUsers`, `blockedAuthors` (deprecated)
- `userMonthlyReport`, `userMonthlySummary`
- `userDonationPreferences`

**Media:**
- `media` — images/videos with faceting
- `externalVideo`
- `requestMediaUploadUrl` — **presigned URL for image/video upload** (takes `filename`, `mimeType`, returns `url` + `uuid`)

**Games & Tags:**
- `game`, `games`, `gameArtwork`, `favouriteGames`
- `tag`, `tags`, `tagCategories`, `tagCategory`, `blockedTags`, `legacyTags`

**Account:**
- `personalApiKey`, `preferences`, `ageVerificationInfo`
- `moderationWarnings`, `moderationReasons`, `currentWarnings`
- `news`, `applications`
- `optedInMods`

**Utility:**
- `uploads`, `temporalWorkflowStatus`, `temporalWorkflowInspection`, `temporalArchiveSearch`
- `speedtestUrls`, `privateMessageUrl`
- `csamHashCheck`, `csamDeletionRequests`
- `badges`, `categories`, `category`
- `wallets`

### Mutations (95 total)

Full list extracted from https://github.com/Arborsm/ModForge-Studio/tree/master/docs/nexusmods-graphql/mutations:

**Comments (full CRUD — requires OAuth):**
- `createComment(commentThreadId, body, replyToId, attachmentIds)` — post comment
- `updateComment` — edit comment
- `discardComment` — delete/discard comment
- `hideComment` / `restoreComment` — moderation
- `likeComment` / `removeCommentLike`
- `lockComment` / `lockCommentThread`
- `pinComment` / `unpinComment`
- `reorderPinnedComments`
- `clearCommentModerationStatus` / `clearCommentThreadModerationStatus`
- `uploadAttachment` — attach files to comments

**Endorsements:**
- `createModEndorsement` / `abstainFromModEndorsement`
- `endorse` (generic)

**Collections (full management):**
- `createCollection`, `editCollection`, `discardCollection`
- `listCollection` / `unlistCollection`
- `createOrUpdateRevision`, `publishRevision`, `retractRevision`, `discardRevision`, `unpublishRevision`, `updateRevision`
- `addImageToCollection`, `removeImageFromCollection`, `modifyImageForCollection`
- `addVideoToCollection`, `removeVideoFromCollection`
- `addHeaderImageToCollection`, `removeHeaderImageFromCollection`
- `addTileImageToCollection`, `removeTileImageFromCollection`
- `addTagToCollection`, `removeTagFromCollection`
- `addBadgeToCollection`, `removeBadgeFromCollection`
- `changeCollectionOwner`

**Collection Bug Reports:**
- `createCollectionBugReport`, `closeCollectionBugReport`, `openCollectionBugReport`
- `hideCollectionBugReport`, `updateCollectionBugReport`
- `clearCollectionBugReportModerationStatus`

**Changelogs:**
- `createChangelog`, `updateChangelog`

**User Management:**
- `updateAboutMe` — edit user profile "about me"
- `updatePreferences`, `updateCountry`
- `updateUserDonationPreferences`
- `addFavouriteGame` / `removeFavouriteGame`
- `blockAuthor` / `unblockAuthor`
- `ignoreUser` / `unignoreUser`
- `trackMod` / `untrackMod`
- `trackUser` / `untrackUser`
- `createApiKey` / `deleteApiKey` / `deletePersonalApiKey`
- `giveKudos` / `removeKudos`
- `rate`

**Media:**
- `uploadAttachment`
- `uploadGameArtworkV2`

**Messages:**
- `createMessage` — send private message

**Moderation:**
- `moderate`, `amendModeration`
- `submitModerationFix`, `acceptModerationFix`, `rejectModerationFix`
- `issueWarningToUser`, `updateModerationWarning`
- `createNoteAboutUser`
- `blockModsFromEarningDp` / `unblockModsFromEarningDp`
- `writeFullPageNotificationToUser`

**System:**
- `trackAppMetric`
- `updateGame`
- `createTag`, `updateTag`, `discardTag`
- `updateModDirectDownloadEnabled`
- `reorderItem`
- `createCsamDeletionRequest`, `updateCsamDeletionRequest`
- `startAgeVerificationFlow`, `startAgeVerificationAppealFlow`

---

## 4. Upload API v3 (`api.nexusmods.com/v3`)

- Status: **Open Beta**
- Auth: API key via `apikey` header; some operations may need OAuth
- Announcement: https://www.nexusmods.com/news/15454
- GitHub Action: https://github.com/Nexus-Mods/upload-action

### Upload Flow (from PHLemp/nexus-mods-mcp — https://glama.ai/mcp/servers/PHLemp/nexus-mods-mcp)

1. **Create upload session**: `POST /v3/uploads` with `size`, `filename`, `MD5`
   - Multipart variant used automatically above 100 MiB
2. **Upload bytes**: `PUT` to presigned storage URL (returned in step 1) with exact headers
3. **Finalize**: `POST /v3/uploads/{id}/finalise`
4. **Poll status**: `GET /v3/uploads/{id}` until status = `"available"` (from `"created"`)
5. **Publish**:
   - Update existing file: `POST /v3/mod-files/{mod_file_id}/versions`
   - Create new file: `POST /v3/mod-files`
6. **Add changelog** (optional): `POST /v3/mods/{uid}/changelogs`

### Other v3 Endpoints (known)
- `GET /v3/games/{game_domain}/mods/{game_scoped_id}` — mod info lookup
- Mod file targets / identifiers for publishing
- Rename mod file / update chain

### Key Notes
- If publish step fails after upload, bytes are already on server; reuse `upload_id` instead of re-uploading
- File ID findable via "API Info" on Files tab or Manage Files edit menu
- Available to all mod authors with API key
- Focused on **updating existing mods** (new file versions)
- [UNVERIFIED] Full mod creation flow may not yet be available

---

## 5. Capabilities NOT in Official API

### Mod Description Editing
- **NOT in any official API** (v1/v2/v3)
- Website uses internal endpoints behind Cloudflare
- **Workaround**: Browser automation (Puppeteer) against `www.nexusmods.com`

### Mod Page Creation
- **NOT in official API**
- Done through `www.nexusmods.com/games/{game}/mods/add` (web form)
- **Workaround**: Browser automation only

### Image/Video Gallery Upload (Mod Pages)
- **Via GraphQL v2**: `requestMediaUploadUrl(filename, mimeType)` returns presigned URL + UUID
- Upload file to presigned URL
- Collection-specific mutations: `addImageToCollection`, `addVideoToCollection`, `addHeaderImageToCollection`, `addTileImageToCollection`
- [UNVERIFIED] Whether `requestMediaUploadUrl` works for non-collection mod page galleries

### Bug Reports (Mod Pages)
- **Collection bug reports**: Available via GraphQL v2 (`createCollectionBugReport`, etc.)
- **Mod page bug reports**: NOT in official API
- Feature request exists: https://forums.nexusmods.com/topic/13537574-comments-and-bug-reports-being-available-in-the-api
- **Workaround**: Browser automation

### Forums (forums.nexusmods.com)
- Platform: **Invision Community** (recently upgraded from v3 to v4)
- Invision Community has its own REST API but unclear if Nexus Mods exposes it publicly
- `forums.nexusmods.com` sits behind Cloudflare (403 to non-browser requests)
- **Workaround**: Browser automation; or Invision REST API if accessible [UNVERIFIED]

### Private Messages / Notifications
- **GraphQL v2**: `createMessage` mutation (sending PM) — requires OAuth
- **GraphQL v2**: `privateMessageUrl` query generates a message URL
- Reading messages: [UNVERIFIED] — may exist in full schema via introspection
- Notifications: Not exposed in API

### Cloudflare Protection
- `www.nexusmods.com` — behind Cloudflare JS challenge; returns 403 to curl/non-browser
- `forums.nexusmods.com` — behind Cloudflare (403 to scrapers)
- `api.nexusmods.com` — **NOT behind Cloudflare challenge** (direct API access works)
- `staticdelivery.nexusmods.com` — no challenge, directly fetchable (media/images)
- `users.nexusmods.com` — accessible (OAuth endpoints)
- Cloudflare Turnstile CAPTCHA used on login/registration pages
- Source: https://forums.nexusmods.com/topic/13521112-cloudflare-blocking-jdownloader/

---

## 6. ToS / API Acceptable Use

Source: https://help.nexusmods.com/article/114-api-acceptable-use-policy
Full ToS: https://help.nexusmods.com/article/18-terms-of-service

### Key Rules
- **Scraping prohibited**: "Fetching data en-masse with the intent to rehost this information on your own service"
- **App registration required** for public apps (personal keys only for testing/individual use)
- **Required headers**: `Application-Name`, `Application-Version` on every request
- **No storing user API keys** without user-initiated action
- **No false request metadata** (blank or fake headers)
- **Open source encouraged** — may deny registration to closed-source projects
- **Right to block** apps violating policy or "detrimental to the modding community"
- No specific rules about MCP servers — standard API rules apply
- Automated posting not explicitly prohibited but covered by general "acceptable use" clause

---

## 7. Existing MCP Servers & Libraries

### MCP Servers

| Name | URL | Language | Tools | APIs Used | Notes |
|------|-----|----------|-------|-----------|-------|
| **nexus-mods-mcp** (PHLemp) | https://github.com/PHLemp/nexus-mods-mcp | TypeScript | 22 | v1 REST, v2 GraphQL, v3 Upload | Most feature-complete; upload flow, changelogs, rename. No comments/description. |
| **@createveai/nexus-mcp-server** | https://www.npmjs.com/package/@createveai/nexus-mcp-server | TypeScript | ? | v1 REST, v2 GraphQL | npm package |
| **@iflow-mcp/nexus** | https://www.npmjs.com/package/@iflow-mcp/nexus | ? | ? | ? | npm package |
| **nexus-mods-mcp** (PyPI) | https://pypi.org/project/nexus-mods-mcp/ | Python | ? | v2 GraphQL | Read-only by design |

### npm Libraries

| Package | Version | Last Updated | Notes |
|---------|---------|-------------|-------|
| **@nexusmods/nexus-api** | 1.1.5 | ~2022 (4+ years old) | Official. TypeScript. v1 REST + SSO WebSocket + experimental OAuth + GraphQL queries. GPL-3.0. No upload. Repo: https://github.com/Nexus-Mods/node-nexus-api |

### Key GitHub Repos

| Repo | Description |
|------|-------------|
| [Nexus-Mods/node-nexus-api](https://github.com/Nexus-Mods/node-nexus-api) | Official Node.js/TS client. v1 REST + GraphQL + SSO + experimental OAuth. GPL-3.0. |
| [Nexus-Mods/sso-integration-demo](https://github.com/Nexus-Mods/sso-integration-demo) | Official SSO WebSocket demo (simple JS) |
| [Nexus-Mods/upload-action](https://github.com/Nexus-Mods/upload-action) | Official GitHub Action for v3 Upload API |
| [Nexus-Mods/API-Example](https://github.com/Nexus-Mods/API-Example) | Official upload automation example |
| [Arborsm/ModForge-Studio](https://github.com/Arborsm/ModForge-Studio) | Has full GraphQL schema extraction (95 mutations documented) |
| [BUTR/BUTR.NexusUploader](https://github.com/BUTR/BUTR.NexusUploader) | Unofficial upload tool (C#) |
| [Pathoschild/FluentNexus](https://github.com/Pathoschild/FluentNexus) | Modern async HTTP client for Nexus API (C#) |

---

## 8. Capability Matrix Summary

| Capability | Method | Key Endpoint/Mutation | Auth |
|-----------|--------|----------------------|------|
| Read mods/files | REST v1 | `GET /v1/games/{g}/mods/{id}`, `/files` | API key |
| Search mods | GraphQL v2 | `mods` query with filters | API key |
| Download files | REST v1 | `GET .../download_link` (premium=direct, free=needs NXM key) | API key |
| Upload mod file | REST v3 | `POST /v3/uploads` -> PUT -> finalise -> `/v3/mod-files` | API key |
| Upload images/video | GraphQL v2 | `requestMediaUploadUrl` -> PUT to presigned URL | OAuth |
| Edit mod description | **NOT IN API** | Browser automation only (Cloudflare-protected) | - |
| Create mod page | **NOT IN API** | Browser automation only | - |
| Comments read | GraphQL v2 | `comment`, `commentThread`, `searchComments` | API key |
| Comments write | GraphQL v2 | `createComment`, `updateComment`, `discardComment` | OAuth |
| Forum read | **NOT IN API** | Invision Community (Cloudflare); browser automation | - |
| Forum write | **NOT IN API** | Invision Community; browser automation | - |
| Send PM | GraphQL v2 | `createMessage` mutation | OAuth |
| Read PM | **NOT IN API** | [UNVERIFIED] | - |
| Bug reports (mod) | **NOT IN API** | Feature request pending; browser automation | - |
| Bug reports (collection) | GraphQL v2 | `createCollectionBugReport` etc. | OAuth |
| Endorsements | REST v1 + GraphQL v2 | `POST .../endorse`, `createModEndorsement` | API key |
| Track mods | REST v1 + GraphQL v2 | `POST /user/tracked_mods`, `trackMod` | API key |
| User validation | REST v1 | `GET /v1/users/validate` | API key |
| Changelogs | REST v1 + v3 | `GET .../changelogs`, `POST /v3/mods/{uid}/changelogs` | API key |
| User profile edit | GraphQL v2 | `updateAboutMe`, `updatePreferences` | OAuth |
