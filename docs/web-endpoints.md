# Web-tier endpoints — evidence log

Rule: a web-tier tool ships only after the real request the website makes was found in
the site's own front-end. Discovery date: 2026-09-23, anonymous headless session
(patchright, UA `HeadlessChrome`→`Chrome`). No logged-in session was available, so every
WRITE below is **untested against the live site**.

Sources inspected:
- `www.nexusmods.com/assets/dist/app-JK43CRMB.js` (legacy jQuery front-end)
- `www.nexusmods.com/assets/dist/web-components-I27OVUU7.js` (new React components)
- `next.nexusmods.com` route chunks (collection comments, profile pages)
- `window.env` block in the mod page HTML
- live HTML of mod page, `CommentContainer` widget, Invision forum index/forum/topic pages

## Transport facts

| Fact | Evidence |
|---|---|
| Public GraphQL used by the site = `https://api-router.nexusmods.com/graphql` | mod page HTML: `window.env.NEXT_PUBLIC_API_PUBLIC_GRAPHQL_URI = "https://api-router.nexusmods.com/graphql"` |
| Site calls it with the session cookie + `X-GraphQL-OperationName` header | web-components bundle: `_r=(e,{method,operationName})=>… headers {"Content-Type":"application/json", "X-GraphQL-OperationName":r} … new GraphQLClient(o,{credentials:"include"})` |
| CORS allows those calls from a `www.nexusmods.com` page | verified: `game(domainName:"skyrimspecialedition")` from the www page → 200 |
| Login check: `preferences` answers only for a session | verified anonymously: `"You must be logged in to retrieve user preferences"`, code `UNAUTHORIZED` |
| `www.nexusmods.com` pages/widgets must be fetched as XHR | verified: mod page fetched from the page without `X-Requested-With` → 403; with it → 200 |
| `forums.nexusmods.com` = Invision Community 4; guest reads OK, pages need `<id>-<slug>` (any slug) | verified: `/forum/9063/` → 404, `/forum/9063-x/` → 200 |
| Other routers (not used): `invision-router.nexusmods.com/graphql` (introspection disabled), `moderation-router…`, `notifications.nexusmods.com` (401 anon) | `window.env` + probes |

## Shipped

| Tool | Request | Evidence | Status |
|---|---|---|---|
| `get_mod_comments` | 1) GET `/{game}/mods/{id}` (XHR) → regex `CommentContainer?…thread_id=N`; 2) GET `/Core/Libs/Common/Widgets/CommentContainer?RH_CommentContainer=game_id:G,object_id:M,object_type:1,thread_id:T,tabbed:1,skip_opening_post:0,page:P` → HTML (`li.comment`, `ol.comment-kids`, `#comment-count[data-comment-count]`) | mod page tab `data-target`; `RequestHelper.prototype.Submit` builds `uri?RH_<id>=` + `$.param(d)` with `=`→`:` `&`→`,` | **verified** (SkyUI, page 2/512) |
| `post_mod_comment` | POST `/mod/comment` form: `game_id, object_id, thread_id, post=encodeURIComponent(text), use_emo, parent_id (0 = top level), _token` → body `1` on success | app bundle `addNewComment()`; map `[1,"/mod/comment"]` for object_type 1; `_token` = `data-csrf-token` of `#submit-add-comment-<parent>` (logged-in widget HTML) | untested (no session); guest run correctly stops at "no form token" |
| `edit_mod_comment` | PUT `/mod/comment` form: `comment_id, use_emo, post, _token` → `{errors, content}` | app bundle `editComment()` | untested |
| `post_collection_comment` | api-router `mutation CreateComment($commentThreadId: ID!, $body: String!, $replyToId: ID, $attachmentIds: [ID!])` | next.nexusmods.com chunk `254hd1s-ubp3z.js` (`useCreateCommentMutation`, `browserClient("api",{operationName:"CreateComment"})`) | untested |
| `edit_collection_comment` | api-router `mutation UpdateComment($commentId: ID!, $body: String!, $attachmentIds: [ID!])` | same chunk (`useUpdateCommentMutation`) | untested |
| `delete_collection_comment` | api-router `mutation DiscardComment($commentId: ID!)` | same chunk | untested |
| `forum_list` | GET forum index / `/forum/<id>-x/[page/N/]` → `li.cForumRow[data-forumid]`, `li.ipsDataItem[data-rowid]` | live HTML | **verified** |
| `forum_topic` | GET `/topic/<id>-x/[page/N/]` → `article.cPost`, `[data-role=commentContent]`, `[data-pages]` | live HTML | **verified** |
| `web_status` | api-router `query Preferences { preferences { __typename } }` | see transport facts | **verified** (anonymous → NOT logged in) |

## TODO (not shipped — missing evidence)

| Capability | What is known | What is missing |
|---|---|---|
| Forum reply / new topic | Invision topic pages; guest HTML has only the `multimodComment` form | Reply form is rendered only for members → field names (`csrfKey`, editor field, submit key) unverified. Needs one logged-in look at a topic page. |
| Forum search | `/search/?q=…&type=forums_topic` returns JSON `{filters,hints,content,title,css}` | Guest search returned 0 results for a common term → behaviour for members unverified. |
| Private messages (read/send) | Site "View messages" / "Send message" link to Invision messenger `forums.nexusmods.com/messenger/` (via `privateMessageUrl` query); anon → 403 "not available to guests". GraphQL `createMessage(to,title,body)` exists in the schema but the site does not call it. | Messenger list/compose forms need a session to inspect. |
| Delete own mod-page comment | Only `/Core/Libs/Common/Managers/Moderation/ChangeCommentModerationStatus` (`game_id, reason, object_id, comment_id, object_type, status, report`) found | `status` value for a self-delete and whether authors/commenters may call it — visible only in logged-in comment menus. |
| Mod image / video upload | `/Core/Libs/Common/Managers/Images/Save` (form incl. `filename`, `_token`), `/ModVideos/Add`; GraphQL `requestMediaUploadUrl(filename,mimeType)` in schema | The mod-page media uploader (file upload step + field set) lives in the author-only edit page. |
| Mod description / page edit | New components post `/api/flamework/mods/save` JSON `{modId, gameId, name, summary, description, categoryId, author, version, type, …}` | Found only in the "Create draft" (new mod) modal; the existing-mod edit form is server-rendered for authors only — risk of wiping fields if replayed blindly. |
| Mod bug reports | `/mod_bug` POST, `/mod_bug/{id}/reply`, `/mod_bug/reply/{id}` PUT | Payload fields not traced yet (lower priority). |
