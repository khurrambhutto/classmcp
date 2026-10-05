# classmcp

Local stdio MCP server for a student's Google Classroom: one-call digests,
search, handout downloads, and best-effort submissions for coding agents.

- Runs on your machine, one Google account per install, no hosted service, no telemetry.
- Uses your own Google OAuth **Desktop app** client; tokens stay in the OS keychain
  (or a `0600` file where no keychain exists).
- Package: [`gcrclassmcp`](https://www.npmjs.com/package/gcrclassmcp) on npm. The command is `classmcp`.

## Quick start

```bash
npm install --global gcrclassmcp
classmcp setup      # store credentials, authorize Google, offer host config
classmcp doctor     # verify everything without printing secrets
```

Then register the server with your agent host (copy-paste configs below) and ask:

> "What's due this week?" · "Find the photosynthesis lab" · "Download the handouts for the waves essay"

Zero-install alternative (slower first start):

```bash
npx -y gcrclassmcp@0.3.0 serve
```

## Google Cloud setup (once)

1. Create a project at <https://console.cloud.google.com>.
2. Enable **Google Classroom API** and **Google Drive API**
   (APIs & Services → Library).
3. Configure the OAuth consent screen:
   - User type: **External** (personal Gmail) or **Internal** (Workspace school account).
   - While in "Testing", add your own account under **Test users**.
4. Create credentials → **OAuth client ID** → Application type **Desktop app**.
5. Download the JSON and run `classmcp setup`; it finds `client_secret*.json`
   in `~/Downloads` or asks for the path.

`setup` validates and stores the client, opens the Google consent page on a
loopback callback, saves tokens, verifies access, and can register the server
in detected host configs. Secrets are never printed.

## Requirements

- Node.js >= 20.
- A student Google account (classmcp always acts as `me`).

## Tools

Five tools. Every call returns compact JSON in `content[0].text` plus typed
`structuredContent` (validated against its `outputSchema`). Failures return
`isError: true` with an actionable message; reads retry Google 429/5xx and
network errors with backoff, while uploads/attach/turn-in are never retried
because they are not idempotent. Partial success is reported in-band
(`errors[]` with an `operation`, per-file results), not as a failure.

| Tool | Answers | Key parameters |
| --- | --- | --- |
| `get_overview` | Digest of the whole classroom in one call | `view` `due`\|`missing`\|`new`\|`grades`\|`courses` (default `due`); `window` 1-30 days (default 7); `limit` 1-50 (default 20); `query` text filter; `includeArchived` also scans ARCHIVED courses (`view=courses` always lists every course; the result reports `skippedArchived`); `detail` `concise`\|`detailed` |
| `get_assignment` | Full detail of one assignment: prompt, due/`daysLeft`, `myState`/late/grade, rubric (when present), teacher attachments with Drive file ids, my attachments, submission history, link | course + assignment fuzzy ref or exact ids; `maxDescChars` 0-2000 (default 400) trims the prompt |
| `search` | Keyword search across assignments, materials, and announcements (all words must match title/description/text); hits carry normalized `attachments` with Drive ids, so any hit is downloadable | `query` (non-empty); `kinds` filter (at least one when provided); `limit` 1-30 (default 10); optional course filter; `includeArchived`; trimmed snippets |
| `download_files` | One assignment's, material's, or announcement's attachments — or explicit file ids — on local disk | `fileIds` ≤20 or every attachment; `exportAs` `pdf`\|`docx`\|`xlsx`\|`pptx` for Google Docs/Sheets/Slides (defaults `docx`/`xlsx`/`pptx`); `destinationDir` must resolve inside `~/Downloads` or `$CLASSMCP_WORKDIR`; per-file partial success |
| `submit_work` | Best-effort submission (see limitations) | ≤10 local files (100 MB each) + ≤10 Drive ids + 1 link (≤20 combined); `turnIn: true` additionally requires `confirmTurnIn: "I confirm turn in"` |

Fuzzy refs: every tool accepts a course name ("Physics 101") or item title
fragment ("photosynthesis lab") anywhere an id is expected — no discovery
round-trip needed. Exact ids skip the listing and go straight to the item,
which keeps repeated calls fast.

Long lists are paginated internally. `get_overview`, `search`, and course
readers report both flavors of truncation: `truncated` (the result limit cut
matches; narrow the query) and `scanTruncated` (an internal safety budget
stopped pagination; very old items may not have been seen).

## MCP resources

Every kind `search` returns has a reader; the resource payload is the same JSON
the tools produce:

- `classroom://courses/{courseId}` — course reader: open/missing work, recent
  materials with attachments, recent announcements, topics.
- `classroom://courses/{courseId}/assignments/{assignmentId}` — full assignment
  detail (same shape as `get_assignment`).
- `classroom://courses/{courseId}/materials/{materialId}` — material detail with
  attachment Drive ids.
- `classroom://courses/{courseId}/announcements/{announcementId}` — announcement
  detail with full text and attachments.

All four autocomplete their ids from names/titles. Nullable enrichment fields
carry reason codes instead of bare nulls: `promptStatus`/`descriptionStatus`/
`textStatus` (`full`\|`trimmed`\|`empty`), `rubricStatus`/`topicStatus`
(`present`\|`none`\|`denied`\|`error`), `historyStatus`
(`present`\|`none`\|`unavailable`), `topicsStatus` — so "no rubric" is never
confused with "could not read the rubric".

## Security and privacy

- **Everything stays local.** Credentials, tokens, and downloaded files never
  leave your machine; there is no backend and no telemetry.
- **File confinement.** Uploads and downloads are restricted to `~/Downloads`
  (plus `$CLASSMCP_WORKDIR`). Paths are canonicalized with `realpath`, so
  symlinks cannot escape the allowed roots. Downloads never follow destination
  symlinks, never overwrite existing files (collisions become `name (1).pdf`),
  and delete partial files on failure.
- **Resource limits.** Downloads are capped at 250 MB per file and 500 MB per
  call, enforced while streaming.
- **Permissions.** `~/.classmcp` is `0700`; `credentials.json` and the fallback
  `tokens.json` are `0600`, repaired on every setup/doctor run.
- **OAuth.** Loopback redirect with a random `state`, a 5-minute timeout, and
  listener cleanup on every path. Desktop-app clients only.
- **Scopes.** `classroom.courses.readonly`, `classroom.coursework.me`,
  `classroom.courseworkmaterials.readonly`, `classroom.announcements.readonly`,
  `classroom.student-submissions.me.readonly`, `classroom.topics.readonly`,
  `drive.readonly`, `drive.file`.
- **Writes are conservative.** `submit_work` stops before turn-in if any upload
  or attachment step fails, and `blocked: true` results are normal outcomes,
  not errors.

## Known limitations

- **Google blocks third-party submissions.** Only the Developer Console project
  that created an assignment may modify its submissions, so `modifyAttachments`
  and `turnIn` return `403 @ProjectPermissionDenied` on teacher-created work
  (verified 2026-09). `submit_work` is best-effort by design: it uploads your
  files to Drive, attempts attach/turn-in, and returns `blocked: true` with the
  Drive links plus the Classroom assignment link to finish in the UI. classmcp
  does not and cannot bypass this restriction.
- **Question answers** (short answer / multiple choice) cannot be set via the
  API for the same reason and are not offered.
- **No detach/unsubmit tools**: the API has only `addAttachments` (no
  `removeAttachments`), and `reclaim` is blocked as above.
- **Topics** require `classroom.topics.readonly`. If you authorized before
  0.3.0, rerun `classmcp setup`; until then `topicsStatus` is `denied`.
- **Archived courses** are excluded from `due`/`missing`/`new`/`grades` unless
  `includeArchived: true`; `view=courses` always lists them.

## Configuration

- `CLASSMCP_WORKDIR` — adds a second allowed file root next to `~/Downloads`.
  The default download directory becomes `<root>/classmcp`, where `<root>` is
  `$CLASSMCP_WORKDIR` when set, else `~/Downloads`.
- `CLASSMCP_CONFIG_DIR` — overrides `~/.classmcp` (tests, multi-account setups).
- `~/.classmcp/credentials.json` — OAuth Desktop client JSON (mode 0600).
- Tokens — OS keychain via keytar (service `classmcp`, account `oauth-tokens`);
  fallback `~/.classmcp/tokens.json` (mode 0600).

## Hosts

All hosts use stdio. `classmcp setup` offers to write these configs; the
command shown in the examples works for both a global install (`classmcp`) and
an explicit Node path, and `setup` never writes a transient `npx` cache path.

<!-- Tested versions are recorded in CHANGELOG.md. -->

| Host | Where | Tested |
| --- | --- | --- |
| Codex CLI | `~/.codex/config.toml` or `codex mcp add` | 0.3.0 |
| OpenCode | `~/.config/opencode/opencode.jsonc` | 0.3.0 |
| Claude Code | `~/.claude.json` (or `claude mcp add`) | config shape only |
| Cursor | `~/.cursor/mcp.json` | config shape only |
| Antigravity | `~/.config/antigravity/mcp.json` | config shape only |

**Codex** — preferred CLI registration:

```bash
codex mcp add classmcp -- classmcp serve
codex mcp list
```

Or `~/.codex/config.toml`:

```toml
[mcp_servers.classmcp]
command = "classmcp"
args = ["serve"]
startup_timeout_sec = 30
tool_timeout_sec = 300
```

**OpenCode** — `~/.config/opencode/opencode.jsonc` (note: `mcp`, not `mcpServers`):

```jsonc
{
  "mcp": {
    "classmcp": {
      "type": "local",
      "command": ["classmcp", "serve"],
      "enabled": true,
      "timeout": 60000
    }
  }
}
```

Verify: `opencode mcp list` → `classmcp connected`.

**Claude Code**:

```bash
claude mcp add classmcp -- classmcp serve
```

Or `~/.claude.json` (user scope):

```json
{
  "mcpServers": {
    "classmcp": {
      "command": "classmcp",
      "args": ["serve"]
    }
  }
}
```

**Cursor / Antigravity** — same `mcpServers` shape:

```json
{
  "mcpServers": {
    "classmcp": {
      "command": "classmcp",
      "args": ["serve"],
      "env": { "CLASSMCP_WORKDIR": "/home/you/school" }
    }
  }
}
```

**MCP Inspector**:

```bash
npx @modelcontextprotocol/inspector --cli classmcp serve
```

## Doctor and troubleshooting

```bash
classmcp doctor        # prints ok/warn/fail lines; exit code 1 on failure
```

It checks Node, credentials presence and permissions, token storage and scopes,
Classroom and Drive reachability, host configs, and the required scope list —
without printing secret values.

| Symptom | Fix |
| --- | --- |
| `Google is not connected` | Run `classmcp setup`. |
| `missing scope(s)` warning | Rerun `classmcp setup` to reauthorize (0.3.0 adds topics). |
| `Stored Google tokens are corrupt` | Rerun `classmcp setup`. |
| Host shows the server as failed/timeout | Use the global `classmcp` command (or an absolute Node path), not an `npx` cache path; increase the host startup timeout to 30s+. |
| Downloads refused | Destination must be inside `~/Downloads` or `$CLASSMCP_WORKDIR` (set it in the host's `env`, not per call). |
| `blocked: true` from `submit_work` | Expected on teacher-created work; finish via the returned Classroom link. |

Logs go to stderr only; stdout carries MCP traffic exclusively.

## Upgrade and uninstall

```bash
npm install --global gcrclassmcp@latest
npm uninstall --global gcrclassmcp
rm -rf ~/.classmcp          # optional: removes credentials and tokens
```

After upgrading across a scope change (e.g. 0.2 → 0.3), run `classmcp setup`
once to refresh consent.

## Development

```bash
npm ci
npm run typecheck && npm run test && npm run build
npm run pack:verify          # pack, install into a temp project, MCP smoke test
node dist/cli.js serve
```

Release process and CI gates: [RELEASE.md](RELEASE.md). Security policy:
[SECURITY.md](SECURITY.md). Changes: [CHANGELOG.md](CHANGELOG.md).

MIT.
