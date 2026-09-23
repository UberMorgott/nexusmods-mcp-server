# nexusmods-mcp-server

MCP server for [Nexus Mods](https://www.nexusmods.com): search mods and collections, read
files/changelogs/requirements, download files, track and endorse mods, upload new file
versions (v3 API), and — through your own browser session — mod comments, bug reports,
forums, private messages, and your mods' media and page text.

## Install

```bash
npm install
npx patchright install chromium   # only for the web tier (comments, bugs, forums, PMs, media)
npm run build
npm run setup                     # API key + optional web session
```

MCP client config:

```json
{
  "mcpServers": {
    "nexusmods-mcp-server": { "command": "node", "args": ["/path/to/nexusmods-mcp-server/build/index.js"] }
  }
}
```

## Access levels

| Level | Needs | Tools |
|---|---|---|
| Zero-config | nothing | GraphQL: `search_mods`, `list_games`, `get_mod_details`, `search_collections`, `get_collection`, `get_collection_comments`, `get_user`, `get_news`, `graphql_query`; web reads: `get_mod_comments`, `get_mod_bugs`, `get_mod_bug`, `forum_list`, `forum_topic` |
| API key | `NEXUS_API_KEY` in `.env` | v1: `validate_user`, `get_game`, `get_mod`, `get_mod_files`, `get_mod_file`, `get_changelogs`, `list_mods`, `get_updated_mods`, `md5_lookup`, `get_download_link`, `download_file`, `get_tracked_mods`, `track_mod`, `endorse_mod`, `get_endorsements`; v3: `get_upload_targets`, `get_mod_file_versions`, `upload_file_version`, `add_changelog` |
| Web session | logged-in nexusmods.com session | comments: `post_mod_comment`, `edit_mod_comment`, `post_collection_comment`, `edit_collection_comment`, `delete_collection_comment`; bugs: `post_mod_bug`, `reply_mod_bug`; forums/PMs: `forum_reply`, `pm_list`, `pm_read`, `pm_send`, `pm_reply`, `pm_leave` |
| Web session, mod author | session of the mod's author/team | `edit_mod_page`, `get_mod_media`, `upload_mod_image`, `delete_mod_image`, `add_mod_video`, `delete_mod_video`, `hide_mod_comment`, `delete_mod_bug` |

Session helpers: `web_status`, `web_login`, `web_set_cookies`. Every web write takes
`dry_run: true` to return the exact prepared request without sending it.

Get a personal API key at <https://www.nexusmods.com/users/myaccount?tab=api>.
Downloads: premium accounts get direct links; free accounts must pass `key` + `expires`
from the site's `nxm://` link (Files tab → Mod Manager Download).

## Uploading a new version

1. `get_upload_targets(game, mod_id)` → v3 mod uid + mod_file ids
2. `upload_file_version(mod_file_id, file_path, version, changelog?, mod_uid?)`

The flow mirrors the official [upload-action](https://github.com/Nexus-Mods/upload-action):
multipart upload → finalise → wait until available → publish version → optional changelog.
New mod pages and a mod's first file must still be created on the website.

## Web tier

Operations the official API only allows with OAuth run through a dedicated headless
Chromium (patchright) with its own profile in `~/.nexusmods-mcp/chrome-profile`. Only
requests the website itself makes are used — see [docs/web-endpoints.md](docs/web-endpoints.md)
for the evidence and the list of not-yet-supported actions (forum search, forum topic
creation, deleting your comments on other authors' mods). Forum/PM tools sign in to the
forums automatically through the site's SSO. This is unofficial and may break when the
site changes. `NEXUS_BROWSER_VISIBLE=1` shows the browser window for debugging.

## Rules

Requests send `Application-Name` / `Application-Version` as required by the
[API acceptable use policy](https://help.nexusmods.com/article/114-api-acceptable-use-policy).
Don't use this server for bulk scraping.

## License

CC BY-NC 4.0 — Copyright (c) 2026 Morgott. See [LICENSE](LICENSE).
