# classmcp

classmcp connects a coding agent to your Google Classroom account through the
Model Context Protocol (MCP). It runs on your computer and uses your own Google
OAuth Desktop app credentials. There is no hosted classmcp service or telemetry.

You can ask an agent to list upcoming or missing work, find an assignment,
download handouts, or prepare a submission. Submission changes are subject to
[Google's project restriction](#submission-limits).

The npm package is named `gcrclassmcp`; the command is `classmcp`. You need
Node.js 20 or newer and a Google account with access to Classroom.

## Install

Install the release candidate from npm:

```bash
npm install --global gcrclassmcp@next
classmcp --version
```

To install from source, clone the repository and install from the project
directory:

```bash
git clone https://github.com/khurrambhutto/classmcp.git
cd classmcp
npm ci
npm install --global .
classmcp --version
```

The `next` tag selects the release candidate. See [RELEASE.md](RELEASE.md) for
the publication process.

## Connect Google Classroom

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a
   project.
2. Enable the Google Classroom API and Google Drive API in that project.
3. Configure the OAuth consent screen. Use an External audience for a personal
   Google account or an Internal audience for an eligible Workspace account.
   If the app is in Testing, add your account as a test user.
4. Create an OAuth client ID with application type **Desktop app**. Download
   its JSON file to your Downloads folder.
5. Run:

   ```bash
   classmcp setup
   ```

   Setup looks for `client_secret*.json` in Downloads and asks for a path if it
   cannot find one. It validates and stores the credentials, opens Google's
   consent page, verifies Classroom access, and offers to configure detected
   agent hosts.
6. Run `classmcp doctor`. Resolve any `fail` lines. On Windows, review the
   config folder's access controls as described in [Security](#security).
7. [Register the server with your agent](#connect-an-agent) if setup did not do
   so. Reconnect or restart the host if needed.
8. Ask your agent to list your courses. A successful `get_overview` call with
   `view: "courses"` confirms that the connection works. An empty course list
   can be valid for an account with no courses.

Use a dedicated test account while evaluating the server. Never paste your
client secret or token files into an agent conversation.

## Ask an agent to set it up

You can copy this request into a coding agent with terminal access. Complete
Google's browser steps yourself when the agent asks.

```text
Set up the classmcp MCP server from https://github.com/khurrambhutto/classmcp.
The package is gcrclassmcp and the command is classmcp. Read its README first.

1. Check that Node.js is version 20 or newer. If it is not, stop and tell me
   what is missing.
2. Install classmcp using the README's current installation instructions. Run
   classmcp --version to confirm the command is available.
3. If I have not already created Desktop app OAuth credentials, ask me to
   follow the Google Cloud setup in the README. Do not create credentials on
   my behalf or request their contents in chat.
4. Run classmcp setup interactively. Let me approve Google's consent page and
   answer any prompts that require my input.
5. Run classmcp doctor. Explain any failures without printing secrets. On
   Windows, remind me to verify who can access the config folder.
6. Register classmcp with this host using the README's host instructions.
   Preserve existing configuration entries and comments. Do not register a
   temporary npx cache path.
7. Reconnect the server, confirm that all five tools are listed, and call
   get_overview with view="courses". Report whether the call succeeded. An
   empty course list is valid; report the result rather than treating it as an
   error.

Never print or paste credentials, tokens, or their file contents. If a step
fails, report the error and stop instead of inventing a value or result.
```

## Connect an agent

All hosts start `classmcp serve` over stdio. Use the `classmcp` executable from
a global install, or an absolute path to Node and this repository's
`dist/cli.js`. Do not register a temporary `npx` cache path.

### Codex CLI

```bash
codex mcp add classmcp -- classmcp serve
codex mcp list
```

Alternatively, add this entry to `~/.codex/config.toml`:

```toml
[mcp_servers.classmcp]
command = "classmcp"
args = ["serve"]
startup_timeout_sec = 30
tool_timeout_sec = 300
```

### OpenCode

Add the entry under `mcp` in `~/.config/opencode/opencode.jsonc`:

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

Run `opencode mcp list` and confirm that `classmcp` is connected. If OpenCode
cannot find the executable, use an absolute Node path and the path to
`dist/cli.js` in the `command` array.

### Claude Code

```bash
claude mcp add classmcp -- classmcp serve
```

Alternatively, add the following entry under `mcpServers` in `~/.claude.json`:

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

### Cursor and Antigravity

Add an entry under `mcpServers` in `~/.cursor/mcp.json` for Cursor or
`~/.config/antigravity/mcp.json` for Antigravity:

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

Preserve any existing entries in your host configuration. To allow a working
folder in addition to Downloads, set `CLASSMCP_WORKDIR` in the host's server
environment. See [Configuration](#configuration).

Codex and OpenCode registration were checked during development. The Claude
Code, Cursor, and Antigravity examples describe their configuration shapes;
they were not all validated against a running host for this release candidate.
See [CHANGELOG.md](CHANGELOG.md) for the recorded validation.

## Use classmcp

Try these requests in your agent:

- "What work is due this week?"
- "Find the photosynthesis lab."
- "Download the handouts for the waves essay."
- "Show me the missing work in Physics."

The server provides five tools:

| Tool | Purpose | Important inputs |
| --- | --- | --- |
| `get_overview` | List due, missing, new, or graded work, or list courses. | `view` defaults to `due`. `window` is 1 to 30 days, default 7. `limit` is 1 to 50, default 20. `includeArchived` includes archived courses for work views. |
| `get_assignment` | Read one assignment, including its prompt, grade, attachments, rubric, and submission history when available. | Supply a course and assignment name or ID. `maxDescChars` is 0 to 2,000, default 400. |
| `search` | Search assignment, material, and announcement titles and text. All query words must match. | `query` is required. `kinds` narrows the search. `limit` is 1 to 30, default 10. |
| `download_files` | Download attachments for an item or the specified Drive file IDs. | Up to 20 `fileIds`. Choose `exportAs` for Google Docs, Sheets, or Slides. The destination must be in an allowed root. |
| `submit_work` | Upload files and attempt to attach or turn in coursework. | Up to 10 local files, 10 Drive IDs, and one link, with at most 20 items combined. Each local file can be up to 100 MB. `turnIn: true` requires `confirmTurnIn: "I confirm turn in"`. |

Use a course name or an exact course ID. Item tools accept the corresponding
name or ID. An exact ID skips name lookup; use IDs when names are ambiguous.
For `download_files`, passing `fileIds` selects only those files, even when an
assignment, material, or announcement is also specified. Google Docs, Sheets,
and Slides export to DOCX, XLSX, and PPTX by default. You can request `pdf`,
`docx`, `xlsx`, or `pptx` with `exportAs`.

`get_overview` excludes archived courses from work views unless
`includeArchived` is true. The `courses` view lists archived courses regardless
of that setting. `view: "missing"` finds overdue work; the default `due` view
shows upcoming work.

Tool responses include JSON text and `structuredContent`. Inspect `errors` and
per-file results for partial failures. `truncated` means the requested result
limit cut the list; narrow the query to see more. `scanTruncated` means an
internal scan limit stopped pagination, so older items may be missing. Reads
retry transient Google errors; uploads, attachment changes, and turn-in calls
are not retried.

In an agent's `execute` code runtime, use bracket notation for ClassMCP tools:

```javascript
await tools.classmcp["get_overview"]({ view: "courses" });
```

### Submission limits

Google restricts submission changes to the developer project that created the
coursework. For teacher-created coursework, third-party attachment and turn-in
calls can return `403 @ProjectPermissionDenied`. `submit_work` is best effort:
it uploads requested files to Drive, attempts the requested Classroom action,
and reports `blocked: true` with links when Google rejects it. Follow the
returned Classroom link to finish the submission. The tool does not attempt
turn-in after an upload or attachment failure.

Question answers cannot be set through this tool. The server also has no
remove-attachment or unsubmit tool.

## MCP resources

Hosts that support MCP resources can read these URIs:

| Resource | Content |
| --- | --- |
| `classroom://courses/{courseId}` | Course work, materials, announcements, and topics. |
| `classroom://courses/{courseId}/assignments/{assignmentId}` | Assignment detail. |
| `classroom://courses/{courseId}/materials/{materialId}` | Material detail and attachment IDs. |
| `classroom://courses/{courseId}/announcements/{announcementId}` | Announcement text and attachments. |

Resource IDs support name and title completion. Status fields distinguish
missing data from denied or unavailable data. For example, `rubricStatus` can
be `present`, `none`, `denied`, or `error`.

## Configuration

| Setting | Purpose |
| --- | --- |
| `CLASSMCP_WORKDIR` | Adds an allowed root for uploads and downloads. The default download directory becomes `<root>/classmcp`. Set it in the MCP server's host environment. |
| `CLASSMCP_CONFIG_DIR` | Overrides the default `~/.classmcp` configuration directory. |
| `~/.classmcp/credentials.json` | Stores the Google OAuth Desktop client JSON by default. |
| `~/.classmcp/tokens.json` | Stores tokens only when OS credential storage is unavailable. |

Without `CLASSMCP_WORKDIR`, the default download directory is
`~/Downloads/classmcp`. Local uploads and downloads must resolve inside
`~/Downloads` or `CLASSMCP_WORKDIR`. See [Security](#security) for permissions.

## Security

classmcp sends requests to Google APIs from your computer. Credentials and
tokens stay in local storage; the server does not send them to a classmcp
backend. Tokens use the OS keychain when available and a local file otherwise.

On macOS and Linux, classmcp sets the config directory to mode `0700` and
secret files to `0600`. Setup and doctor can repair Unix modes. Windows uses
access-control lists instead of Unix modes. Files inherit their folder's access
controls, and classmcp does not verify or repair those ACLs. Restrict the
config folder to trusted accounts.

Paths pass canonical `realpath` checks. Downloads do not follow destination
symlinks or overwrite existing files; a collision creates a name such as
`handout (1).pdf`. Partial downloads are removed on failure. Download limits
are 250 MB per file and 500 MB per call.

Google authorization uses a loopback callback with a random state and a
five-minute timeout. The requested scopes are `classroom.courses.readonly`,
`classroom.coursework.me`, `classroom.courseworkmaterials.readonly`,
`classroom.announcements.readonly`, `classroom.student-submissions.me.readonly`,
`classroom.topics.readonly`, `drive.readonly`, and `drive.file`.

Report security issues using the process in [SECURITY.md](SECURITY.md).

## Troubleshooting

Run `classmcp doctor` to inspect credentials, token storage, scopes, API
connectivity, and host configuration. It reports `ok`, `warn`, and `fail`
lines without printing secret values. A failure gives the command exit code 1.

| Problem | Action |
| --- | --- |
| Google is not connected, a token is corrupt, or a scope is missing. | Run `classmcp setup` to authorize again. Authorization from before 0.3.0 may lack the topics scope. |
| The host reports a timeout or cannot start the server. | Use the global executable or absolute Node and script paths. Increase the host's startup timeout. |
| A file path is refused. | Use a path inside `~/Downloads` or the host's configured `CLASSMCP_WORKDIR`. |
| `submit_work` returns `blocked: true`. | Follow the returned Classroom link. See [Submission limits](#submission-limits). |

The server writes logs to stderr. Its stdout is reserved for MCP messages.

## Uninstall

Remove the globally installed command with:

```bash
npm uninstall --global gcrclassmcp
```

Uninstalling the package does not delete your local credentials or tokens.
Remove the config directory separately if you no longer need those files.

## Landing page

Visit <https://khurrambhutto.github.io/classmcp/>.

Run `npm run site:dev`, then open <http://127.0.0.1:4173>. Set `PORT` to use
a different port. The site lives in [`site/`](site/) and requires no build
step. GitHub Pages serves the root of the `gh-pages` branch.
After committing site changes, deploy them with:

```bash
git subtree push --prefix=site origin gh-pages
```

The site serves its font locally and includes its license in `site/assets/`.
Keep the setup commands, host examples, and agent prompt aligned with this
README when you change the installation process.

## Development

```bash
npm ci
npm run check
npm run pack:verify
node dist/cli.js serve
```

`npm run check` runs typechecking, tests, and the build. `pack:verify` packs the
project, installs it in a temporary project, and checks MCP startup and tool
discovery. See [RELEASE.md](RELEASE.md) for release gates and
[CHANGELOG.md](CHANGELOG.md) for changes. The project uses the [MIT license](LICENSE).
