# AGENTS.md

Local Google Classroom MCP server. TypeScript, Node >= 20. Package name
`gcrclassmcp`, executable `classmcp`.

Run `npm run typecheck`, `npm run test`, `npm run build` before finishing.
`npm run check` runs all three; `npm run pack:verify` packs the tarball,
installs it into a fresh project, and smoke-tests the stdio server.

Tool surface (5 tools): `get_overview`, `get_assignment`, `search`, `download_files`, `submit_work`.

Keep `runServer` lazy: connect first, load Google per tool call via the cached `getServices()` factory (see Solved issues).

Call ClassMCP tools inside the `execute` code runtime with bracket notation, e.g. `tools.classmcp["get_overview"]({})` (see Solved issues).

Release process: `RELEASE.md`. Host configs: `README.md`. Changes: `CHANGELOG.md`.

## Invariants (do not regress)

- All file paths go through `assertInsideRoots` (canonical `realpath` checks).
- Downloads never overwrite or follow symlinks; collisions become `name (1).ext`.
- Non-idempotent writes (`drive.files.create`, `modifyAttachments`, `turnIn`)
  are never retried, and turn-in never runs after a failed upload/attach.
- Google list calls go through the `scanAll` helpers and report
  `scanTruncated`; per-endpoint failures use `errors[].operation`.
- stdout is MCP traffic only; log to stderr. `setup` is the only command that
  may open readline.
- Secret files are `0600`, the config dir `0700`, repaired on setup/doctor.

## Solved issues

### OpenCode shows classmcp as failed / timed out

Cause was `runServer` awaiting `createServices()` before `server.connect()`. Imports plus keychain plus auth made startup take 10s+, OpenCode gave up.

Fix in `src/server.ts`: connect first, load Google lazily per tool call with a cached `getServices()` factory. Keep it that way. Verify with `opencode mcp list`, expect `classmcp connected`.

### OpenCode does not pick up classmcp

- OpenCode v1.18 uses `mcp`, not `mcpServers`. Entry lives in `~/.config/opencode/opencode.jsonc`.
- Command must be an array with an absolute node path, pointing at the local build. Delete the stale `~/.config/opencode/opencode.json` that used the old `mcpServers` plus `npx classmcp@0.1.0` form.
- Working entry: `classmcp` type `local`, command `["/home/khurram/.local/share/mise/installs/node/26.7.0/bin/node", "/home/khurram/Projects/classmcp/dist/cli.js", "serve"]`, enabled true, timeout 60000.

### Calling classmcp tools from an agent

Call ClassMCP tools inside the `execute` code runtime with bracket notation. `tools.classmcp.get_overview({})` fails with unknown tool. Use `tools.classmcp["get_overview"]({})`.

### Submission writes are project-restricted

Submission writes (attach/turn-in/reclaim) are 403 @ProjectPermissionDenied for any third-party OAuth project on teacher-created coursework (verified live 2026-09) — do not attempt to "fix" turn_in; submit_work is intentionally best-effort.
