# Release checklist

Every published version must pass this list. Automated gates run in
`.github/workflows/ci.yml`; publishing is handled by
`.github/workflows/release.yml` (npm trusted publishing with provenance).

## 0. Preconditions

- [ ] `npm whoami` shows the publishing account; `gcrclassmcp` is owned by it.
- [ ] `npm view gcrclassmcp` does not already contain the version being shipped.
- [ ] `git status` is clean on the release branch (`release/x.y.z`).
- [ ] CHANGELOG has a section for the version with a date.

## 1. Local gate

```bash
npm ci
npm run typecheck
npm test
npm run build
git diff --check
npm audit --omit=dev          # expect: found 0 vulnerabilities
npm run pack:verify           # tarball install + MCP stdio smoke test
```

- [ ] All commands pass.
- [ ] `pack:verify` reports exactly five tools and clean stdout.

## 2. Security review

- [ ] Symlink escape, destination collision, and size-limit tests pass.
- [ ] Submission sequencing tests pass (no turn-in after failed upload/attach).
- [ ] OAuth state/timeout/denial tests pass; listener closes on every path.
- [ ] Tarball contains no credentials, tokens, tests, source maps, reports, or
      absolute development paths (pack:verify checks the file list).
- [ ] No secret values appear in tool output, errors, or logs.

## 3. Release candidate

```bash
npm version 0.3.0-rc.1 --no-git-tag-version   # first RC only
npm publish --tag next --provenance           # via CI for tagged builds
```

- [ ] Install the registry package (`npm install --global gcrclassmcp@next`) on
      a clean machine, not from the repository.
- [ ] Run `classmcp setup`, then `classmcp doctor` against a dedicated test
      Google account.
- [ ] Smoke tests: overview (due/missing), assignment detail, search, download,
      upload-only `submit_work`, expected `blocked: true` behavior.
- [ ] Host validation with the registry package:
  - [ ] Codex: `codex mcp add`, `codex mcp list`, tool call.
  - [ ] OpenCode: `opencode mcp list` → `classmcp connected`, tool call.
  - [ ] Claude Code: `claude mcp add`, tool call.
  - [ ] Cursor: config entry, tool discovery, one local file operation.
- [ ] Record tested host versions in CHANGELOG/README.

## 4. Stable release

- [ ] Promote the validated RC to `0.3.0` (`npm version 0.3.0`).
- [ ] Repeat the full local gate and CI on the tagged commit.
- [ ] `npm publish --access public --provenance` via CI.
- [ ] Push tag `v0.3.0`; create GitHub release notes from CHANGELOG.
- [ ] Install `gcrclassmcp@0.3.0` from the public registry into a clean
      environment and repeat the smoke test.
- [ ] Verify provenance on the npm package page.

## 5. Post-release

- [ ] Watch install/setup reports grouped by OS, Node, host, and install mode.
- [ ] Patch forward; never unpublish.
- [ ] Keep the audit and compatibility CI scheduled.

## Version policy

- Patch: bug fixes, no contract changes.
- Minor: additive fields/tools behavior; breaking changes get major or an
  explicit RC note.
- `1.0.0` only after a stable release cycle with no unresolved high-severity
  issues and stable tool/output contracts.
