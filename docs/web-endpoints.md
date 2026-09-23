# Web-tier endpoints — evidence log

Rule: a web-tier tool ships only after the real request the website makes was found in
the site's own front-end. Discovery: 2026-09-23 — first anonymous, then with a logged-in
session (account UberMorgott, member 6541781, author of `windrose/147`), headless
patchright (UA `HeadlessChrome`→`Chrome`) through the server's own `BrowserClient`.

Sources inspected:
- `www.nexusmods.com/assets/dist/app-JK43CRMB.js` (legacy jQuery front-end: comments, bugs)
- `www.nexusmods.com/assets/dist/web-components-I27OVUU7.js` (new React components)
- `www.nexusmods.com/_next/static/chunks/*` of the mod editor `/games/<game>/mods/<id>/edit/{general,media,files,requirements,permissions}`
  (e.g. `314_h3e1lv0h-.js` flameworkFetch + postSaveMod, `2g8c7bgxq3ffd.js` mapFormDataToSaveParams + media API,
  `36_5jo47-l47-.js` media tab, `0jn28-u0m_7wf.js` image upload + CsamHashCheck, `0ugceaebkzstf.js` editor save flow)
- `forums.nexusmods.com/uploads/javascript_global/root_framework.js`, `root_front.js` (Invision 4)
- `next.nexusmods.com` route chunks (collection comments, profile pages)
- live logged-in HTML: mod page, `CommentContainer`, `ModBugsTab`, `ModBugReplyList`, `AddBugReportPopUp`,
  `DeleteAndReportCommentPopUp`, forum topic, `/messenger/`, `/messenger/<id>/`, `/messenger/compose/`
- network log of the mod editor page load (api-router `Mod`/`ModFiles`, `/api/flamework/mods/{settings,media,requirements,documentation,articles,categories}`)

## Transport facts

| Fact | Evidence |
|---|---|
| Public GraphQL used by the site = `https://api-router.nexusmods.com/graphql` | `window.env` / runtime-config `NEXT_PUBLIC_API_PUBLIC_GRAPHQL_URI` |
| Site calls it with the session cookie + `X-GraphQL-OperationName` header | web-components bundle `_r=(e,{method,operationName})=>…`, `credentials:"include"` |
| CORS allows those calls from a `www.nexusmods.com` page — and NOT from `users.nexusmods.com` | runtime-config `NEXT_PUBLIC_ALLOWED_CORS_ORIGINS = https://www.nexusmods.com`; verified: fetch from a page parked on users.nexusmods.com → `TypeError: Failed to fetch` |
| Login check: `preferences` answers only for a session | anonymous → `UNAUTHORIZED`; logged in → `{preferences:{__typename:"Preference"}}` |
| `www.nexusmods.com` pages/widgets must be fetched as XHR | mod page without `X-Requested-With` → 403; with it → 200 |
| Mod editor backend = "flamework": `POST https://www.nexusmods.com/api/flamework/...` JSON, `credentials: include`, no CSRF token | `flameworkFetch` in `314_h3e1lv0h-.js`: `fetch(s,{body:JSON.stringify(e),credentials:"include",headers:{"Content-Type":"application/json"},method:"POST"})`; `NEXT_PUBLIC_FLAMEWORK_URI = https://www.nexusmods.com` |
| `forums.nexusmods.com` = Invision Community 4, separate session; guest reads OK, pages need `<id>-<slug>` | `/forum/9063/` → 404, `/forum/9063-x/` → 200; logged-in www session still shows `memberID: 0` on the forums |
| Forum sign-in = SSO: opening `forums.nexusmods.com/login/` with a valid nexusmods.com session signs in silently | verified: → `/?&_fromLogin=1`, `memberID: 194584690`, `/messenger/` 403 → 200 |
| Invision editor posts HTML; the `<name>_noscript` textarea sits inside `<noscript>` and must not be sent | compose/reply markup `<noscript><textarea name="messenger_content_noscript">`; verified live: sending it (empty) → "This field is required" for the message |
| Invision recipient autocomplete stores names newline-separated | `root_framework.js`: `valueField.val(tokens.getValues().join("\n"))` |

## Shipped

| Tool | Request | Evidence | Status |
|---|---|---|---|
| `get_mod_comments` | GET mod page (XHR) → `thread_id`; GET `/Core/Libs/Common/Widgets/CommentContainer?RH_CommentContainer=game_id:G,object_id:M,object_type:1,thread_id:T,tabbed:1,skip_opening_post:0,page:P` | mod page tab `data-target`; `RequestHelper.prototype.Submit` | **verified** |
| `post_mod_comment` | POST `/mod/comment` form `game_id, object_id, thread_id, post=encodeURIComponent(text), use_emo, parent_id, _token` → `1` | app bundle `addNewComment()`; `_token` = `data-csrf-token` in the logged-in widget | **verified live** (own mod, then hidden) |
| `edit_mod_comment` | PUT `/mod/comment` form `comment_id, use_emo, post, _token` → `{errors, content}` | app bundle `editComment()` | untested live |
| `hide_mod_comment` | GET `/Core/Libs/Common/Widgets/DeleteAndReportCommentPopUp?game_id&object_id&object_type=1&comment_id` → button `.delete-and-report-comment` data (`status=2`); POST `/Core/Libs/Common/Managers/Moderation/ChangeCommentModerationStatus` form `game_id, reason, object_id, comment_id, object_type, status, report` → `{status, message}` | logged-in comment "Manage → Hide and optionally report post"; app bundle `.delete-and-report-comment` click handler | **verified live** ("This comment is now hidden") |
| `post_collection_comment` / `edit_collection_comment` / `delete_collection_comment` | api-router `CreateComment` / `UpdateComment` / `DiscardComment` | next.nexusmods.com chunk `254hd1s-ubp3z.js` | untested live |
| `forum_list` / `forum_topic` | GET forum index / `/forum/<id>-x/[page/N/]`, `/topic/<id>-x/[page/N/]` | live HTML | **verified** |
| `forum_reply` | POST topic URL (form action), XHR urlencoded: form fields (`commentform_<id>_submitted, csrfKey, _contentReply, MAX_FILE_SIZE, plupload, topic_comment_<id>`=HTML, `topic_auto_follow, hide`) + `currentPage, _lastSeenID` → JSON `{type: add|redirect|merge|error}` | `root_front.js` `quickReply()`: `ips.getAjax()(form.attr('action'),{data:form.serialize()+'&currentPage='+page+'&_lastSeenID='+_lastSeenID,type:'post'})`; member-only reply form on a live topic | dry-run verified; same code path live-verified via `pm_reply`; not posted publicly |
| `pm_list` | GET `/messenger/` → `li.cMessage[data-messageid]` | live HTML | **verified live** |
| `pm_read` | GET `/messenger/<id>/` → `article.ipsComment` | live HTML | **verified live** |
| `pm_send` | POST `/messenger/compose/` multipart: `form_submitted, csrfKey, MAX_FILE_SIZE, plupload, messenger_to` (names `\n`-joined), `messenger_title, messenger_content`=HTML → redirect to `/messenger/<id>/` | live compose form | **verified live** (to self, then left) |
| `pm_reply` | Invision quick-reply on `/messenger/<id>/` (`messenger_comment_<id>`) | as `forum_reply` | **verified live** (response `type: add`) |
| `pm_leave` | GET `/messenger/<id>/?do=leaveConversation&csrfKey=K` | conversation page link | **verified live** (conversation gone from inbox) |
| `get_mod_bugs` | GET `/Core/Libs/Common/Widgets/ModBugsTab?RH_ModBugsTab=game_id:G,id:M,page_size:10,page:P[,status:S]` → `tr.mod-issue-row` | mod page tab `data-target`; `RH.out_items {"game_id","id","page_size"}`; status `<select>` values | **verified** (baldursgate3/141, 15 pages) |
| `get_mod_bug` | POST `/Core/Libs/Common/Widgets/ModBugReplyList` form `issue_id` | app bundle `loadIssueReplies()` | **verified** |
| `post_mod_bug` | token: GET `/Core/Libs/Common/Widgets/AddBugReportPopUp?game_id&mod_id` → `#submit-report[data-csrf-token]`; POST `/mod_bug` form `mod_id, game_id, title, content, make_private (true/false), _token` → JSON `"1"` | app bundle `addBugReport()` | **verified live** (own mod, private, then deleted) |
| `reply_mod_bug` | POST `/mod_bug/<issue>/reply` form `content, _token` (token on `.add-bug-reply` in ModBugReplyList) → `{status, html, message}` | app bundle `.add-bug-reply` handler | **verified live**; once answered HTTP 500 although the reply was saved → tool re-reads the thread to confirm |
| `delete_mod_bug` | POST `/Core/Libs/Common/Entities/ModBugIssue?DeleteIssue` form `issue_id` → `1` | app bundle `deleteIssue()` | **verified live** (see caveat below) |
| `edit_mod_page` | load: api-router `query Mod($modId,$gameId)` (verbatim editor query) + GET `/api/flamework/mods/settings`; save: POST `/api/flamework/mods/save` JSON `{modId, gameId, name, summary (\n→<br />), description (decodeBBCode'd BBCode), categoryId, author, version, type, languageId, originalModId?, tags[{id,selected}], classtags[], saveAllTags:true}` → `{success, modId}` | editor network log; `mapFormDataToSaveParams`, `decodeBBCode`, editor `save()` in `0ugceaebkzstf.js` | **verified live** (identical save; page text unchanged after) |
| `get_mod_media` | GET `/api/flamework/mods/media?gameId&modId` → `{settings, headerImage, primaryImage, authorImages, authorVideos, hiddenImages, userImages, userVideos}` | editor network log + response zod schema | **verified** |
| `upload_mod_image` | api-router `CsamHashCheck(md5Hashes:[md5 hex])` must return `match:false`; POST `/api/games/<gameId>/mods/<modId>/images` multipart `image` (+`show_in_gallery=0`), `Accept: application/json` → `{message (HTML with data-image-id), position, primary, status, verified}`; then POST `/api/flamework/mods/media/save` `{gameId, modId}` | `uploadModImage`/`legacyUpload`/`checkCsamContent` in `0jn28-u0m_7wf.js`; `clearMediaCache` | **verified live** (uploaded, then deleted) |
| `delete_mod_image` | POST `/api/flamework/mods/media/images` JSON `{action:"delete", gameId, imageId}` + media/save | `postImageAction("delete",…)`, call `y.mutate({gameId,imageId})` | **verified live** |
| `add_mod_video` | POST `/api/flamework/mods/media/videos` JSON `{action:"add", description, gameId, modId, title, url}` → `{success, videoId}` + media/save | `postVideoAction("add",…)` in media tab | **verified live** (then deleted) |
| `delete_mod_video` | POST `/api/flamework/mods/media/videos` JSON `{action:"delete", gameId, modId, videoId, videoType}` (editor default type 7) + media/save | `postVideoAction("delete",…)` | **verified live** |
| `web_status` | api-router `query Preferences { preferences { __typename } }` | transport facts | **verified** (logged in) |

Caveat — `delete_mod_bug`: in one live run a reply posted to the test report stayed in the
database after `DeleteIssue` (still returned by `ModBugReplyList` for the deleted id, not
listed anywhere else); `POST /Bugs?DeleteBugReply {id}` then answers "Bug report reply not
found". Delete replies you care about first, or leave the report closed instead.

## TODO (not shipped — missing evidence)

| Capability | What is known | What is missing |
|---|---|---|
| Forum search | `/search/?q=…&type=forums_topic` (XHR → JSON `{filters,hints,content,title,css}`; full page with `quick=1`) | Returns "There were no results for your search" even logged in, for common terms (`skyui`, `vortex`); searches closer than ~30 s apart answer HTTP 429. Nothing usable to parse. |
| New forum topic | Invision `/forum/<id>-x/?do=add` | Not inspected (not requested); would follow the same Invision form rules. |
| Delete own comment on someone else's mod | Author/moderators get "Hide and optionally report post" (shipped as `hide_mod_comment`) | The account has no comments on other authors' mods, so the commenter-side menu was not observable. |
| Mod bug report edit / status / priority | `PUT /mod_bug/<id>` `{content|title, _token}`, `/mod_bug/reply/<id>` PUT, `ModBugIssue?ChangeStatus` / `?ChangePriority` / `?ToggleLocking` (app bundle) | Not requested; not implemented. |
