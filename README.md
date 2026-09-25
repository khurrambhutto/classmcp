# classmcp

Local stdio MCP server for a student's Google Classroom. Runs on your machine,
uses your own Google OAuth Desktop client, keeps tokens in the OS keychain. One
Google account per install. No hosted service, no telemetry. MIT.

## Requirements

- Node >= 20
- A Google Cloud project with the Google Classroom API and Google Drive API
  enabled, an OAuth **Desktop app** client, and its downloaded JSON file
- A student Google account (classmcp acts as `me`)

## Setup

```bash
npm install
npm run build
node dist/cli.js setup
```

`setup` does, in order:

1. Finds `client_secret*.json` (or `credentials*.json`) in `~/Downloads`, or asks
   for a path; validates it and stores it at `~/.classmcp/credentials.json`
   (mode 0600).
2. Opens the Google consent flow in the browser over loopback
   (`http://127.0.0.1:53682/oauth2callback`).
3. Saves tokens in the OS credential store (keytar). Where none is available it
   warns and falls back to `~/.classmcp/tokens.json` (mode 0600).
4. Verifies access by listing your courses.
5. Offers to register the server in detected MCP client configs. The exact
   command is printed before anything is written. Codex (`.toml`) is never
   modified — it gets a snippet to paste.

## Run and test

```bash
npm run build && npm run typecheck && npm test
node dist/cli.js serve
```

- `opencode mcp list` should show `classmcp connected`.
- MCP Inspector: `npx @modelcontextprotocol/inspector --cli node dist/cli.js serve`
- Smoke test: ask the agent "what's due this week?".

## Tools

Five tools. Every call returns compact JSON in `content[0].text` plus typed
`structuredContent` (validated against its `outputSchema`). Failures return
`isError: true` with an actionable message; Google 429/5xx responses are
retried with backoff. Partial success is reported in-band (`errors[]` on
`get_overview`, per-file results on `download_files`), not as a failure.

| Tool | Answers | Key parameters |
| --- | --- | --- |
| `get_overview` | Digest of the whole classroom | `view` `due`\|`missing`\|`new`\|`grades`\|`courses` (default `due`); `window` 1-30 days (default 7); `limit` 1-50 (default 20); `query` text filter; `detail` `concise`\|`detailed` |
| `get_assignment` | Full detail of one assignment: prompt, due/`daysLeft`, `myState`/late/grade, rubric (when present), teacher attachments with Drive file ids, my attachments, submission history, link | course + assignment fuzzy ref or ids; `maxDescChars` 0-2000 (default 400) trims the prompt |
| `search` | Keyword search across assignments, materials, announcements in ACTIVE courses (all tokens must match title/description/text) | `query`; `kinds` filter; `limit` 1-30 (default 10); optional course filter; trimmed snippets |
| `download_files` | One assignment's attachments (or explicit file ids) on local disk | `fileIds` ≤20 or all attachments; `exportAs` `pdf`\|`docx`\|`xlsx`\|`pptx` for Google Docs/Sheets/Slides (defaults `docx`/`xlsx`/`pptx` — raw media download fails on native docs, so they are exported via `drive.files.export`); `destinationDir` must resolve inside `~/Downloads` or `$CLASSMCP_WORKDIR` (default `<root>/classmcp`); per-file partial success |
| `submit_work` | Best-effort submission (see below) | up to 10 local files, 100 MB each; `turnIn: true` additionally requires `confirmTurnIn: "I confirm turn in"` |

Fuzzy refs: `get_assignment`, `search`, `download_files`, and `submit_work`
accept a course name ("Physics 101") or assignment title fragment
("photosynthesis lab") anywhere a course or assignment id is expected — no
discovery round-trip needed. `get_overview.detail` (`concise` default,
`detailed`) trades payload size for depth.

## MCP resources

- `classroom://courses/{courseId}` — JSON overview of one course with recent
  coursework.
- `classroom://courses/{courseId}/assignments/{assignmentId}` — compact
  assignment status (turn-in state, grade, materials).

Both support `completion/complete`: type part of a course or assignment name to
get matching ids.

## What the Google API does not allow

Google only lets the Developer Console project that *created* an assignment
modify student submissions on it. For every third-party OAuth client the
submission mutations (`modifyAttachments`, `turnIn`, `reclaim`) return
`403 @ProjectPermissionDenied` on teacher-created coursework (verified live
2026-09). This is a platform restriction, not a classmcp bug:

- `submit_work` is best-effort by design. It uploads your files to Drive,
  attempts the attach and optional turn-in steps, and on teacher-created work
  reports `blocked: true` together with the Drive links and the Classroom
  assignment link so you finish in the Classroom UI. `blocked: true` is a
  result, not an error.
- The `confirmTurnIn` literal is kept for host compatibility (see below).
- Answering short-answer or multiple-choice questions is not offered —
  `studentSubmissions.patch` is project-restricted the same way.
- There are no detach or unsubmit tools: `ModifyAttachmentsRequest` has only
  `addAttachments` (the API has no `removeAttachments`), and `reclaim` is
  blocked as above.

## Configuration

- `CLASSMCP_WORKDIR` — adds a second allowed file root next to `~/Downloads`.
  The default download directory becomes `<root>/classmcp`, where `<root>` is
  `$CLASSMCP_WORKDIR` when set, else `~/Downloads`. No other environment
  variables are read.
- `~/.classmcp/credentials.json` — OAuth Desktop client JSON (mode 0600).
- Tokens — OS keychain via keytar (service `classmcp`, account `oauth-tokens`);
  fallback `~/.classmcp/tokens.json` (mode 0600).
- OAuth scopes (7), all under `https://www.googleapis.com/auth/`:
  `classroom.courses.readonly`, `classroom.coursework.me`,
  `classroom.courseworkmaterials.readonly`, `classroom.announcements.readonly`,
  `classroom.student-submissions.me.readonly`, `drive.readonly`, `drive.file`.

## Hosts

Works on Claude Code, Cursor, OpenCode, and Codex (all stdio). `node dist/cli.js
setup` writes these shapes; an `env` key may be added next to `command` to set
variables such as `CLASSMCP_WORKDIR`.

OpenCode — `~/.config/opencode/opencode.jsonc`, `mcp` key, absolute command
array:

```jsonc
{
  "mcp": {
    "classmcp": {
      "type": "local",
      "command": ["/usr/bin/node", "/home/you/Projects/classmcp/dist/cli.js", "serve"],
      "enabled": true,
      "timeout": 60000
    }
  }
}
```

Claude Code — `~/.claude.json`, `mcpServers` key:

```json
{
  "mcpServers": {
    "classmcp": {
      "command": "/usr/bin/node",
      "args": ["/home/you/Projects/classmcp/dist/cli.js", "serve"]
    }
  }
}
```

Cursor (`~/.cursor/mcp.json`) and Antigravity (`~/.config/antigravity/mcp.json`)
use the same `mcpServers` shape. Codex (`~/.codex/config.toml`) is never
modified; setup prints:

```toml
[mcp_servers.classmcp]
command = "/usr/bin/node"
args = ["/home/you/Projects/classmcp/dist/cli.js", "serve"]
```
