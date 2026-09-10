# classmcp

Local Google Classroom MCP server for students. It does not host credentials or student data.

## Setup

1. Create a Google Cloud project and enable Google Classroom API and Google Drive API.
2. Configure the OAuth consent screen and create a **Desktop app** OAuth client.
3. Download the JSON file into `Downloads`.
4. Run:

```bash
npx -y classmcp@0.1.0 setup
```

The setup command opens Google OAuth, stores tokens locally, verifies access by listing all courses, and optionally configures detected MCP clients. It does not need `sudo`.

Tokens use the operating system credential store when available. On headless systems without one, classmcp warns and uses a permissions-restricted file at `~/.classmcp/tokens.json`.

Run the server manually with `npx -y classmcp@0.1.0 serve`.

## Tools

Reads: `list_courses`, `list_assignments`, `get_assignment`, `list_materials`.

Writes: `download_material` (destination must be absolute), `upload_local_file`
(max 100 MB, returns the Drive file id), `attach_file_to_submission`
(does not turn in), `turn_in_submission` (destructive — requires the exact
confirmation string `I confirm turn in`, only after the student confirms).

Digests (one call across all ACTIVE courses, prefer over per-course loops):
`whats_due` (daysAhead 1-90, default 14; limit 1-100, default 50),
`assignment_status` (maxDescChars 0-2000, default 300; prefer over
`get_assignment`), `whats_new` (sinceDays 0-30, default 1; limit 1-100,
default 30).

Failed tool calls return `isError: true` with an actionable message instead of
throwing.
