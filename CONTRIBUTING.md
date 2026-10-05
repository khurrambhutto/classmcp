# Contributing

Thanks for helping make classmcp better. This project is a local stdio MCP
server for Google Classroom; contributions are welcome for tools, reliability,
documentation, and host compatibility.

## Setup

```bash
git clone https://github.com/khurrambhutto/classmcp.git
cd classmcp
npm ci
npm run check        # typecheck + tests + build
```

To exercise the server against a real Google account you need your own Desktop
app OAuth client: follow the Google Cloud setup section in the README, then
`node dist/cli.js setup`.

Never commit credentials, tokens, `~/.classmcp` contents, real student data, or
downloaded coursework. Tests must not require Google credentials or network
access.

## Project rules

- Keep the tool surface at **five tools** with deterministic registration order.
- Keep `runServer` lazy: connect first, initialize Google only inside
  tool/resource calls. Startup must not touch credentials, keychain, or network.
- Any file path from a tool must pass `assertInsideRoots` (canonicalized).
- Never retry non-idempotent writes (`drive.files.create`, `modifyAttachments`,
  `turnIn`).
- Never attempt to work around Google's `ProjectPermissionDenied` restriction.
- stdout is MCP traffic only; log to stderr.
- New Google list endpoint usage must go through the `scanAll` helpers and
  report `scanTruncated` rather than silently dropping pages.
- Update `README.md` and `CHANGELOG.md` when behavior changes.

## Tests

```bash
npm test                       # vitest, no credentials needed
npm run typecheck
npm run pack:verify            # tarball + stdio smoke test
```

Add regression tests with every fix. Security-sensitive areas (path
confinement, submission sequencing, OAuth callback, pagination, cancellation)
should have explicit failure-path tests.

## Pull requests

1. One focused change per PR; describe the problem, the fix, and how it was
   verified.
2. Include the output of `npm run check` in the PR description.
3. Note any host that was tested manually (Codex, OpenCode, Claude Code,
   Cursor) and how.
4. Keep the diff free of unrelated formatting churn.

Security issues should go through [SECURITY.md](SECURITY.md), not public PRs.
