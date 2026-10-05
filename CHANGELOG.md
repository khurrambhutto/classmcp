# Changelog

All notable changes to this project are documented here. The format loosely
follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [0.3.0-rc.1] — unreleased

Release candidate for the first public npm release (`gcrclassmcp`, command
`classmcp`). Breaking changes are marked.

### Security

- **Path confinement is now canonical.** Allowed roots and targets are resolved
  with `realpath`; symlinks that escape a root are rejected for both uploads and
  downloads, including symlinked parents of not-yet-existing files.
- Downloads open destinations exclusively, never follow symlinks, never
  overwrite existing files (`name (1).pdf`), and remove partial files on
  failure. Per-file (250 MB) and per-call (500 MB) limits are enforced while
  streaming.
- OAuth callback: listener binds before the browser opens, uses an ephemeral
  loopback port, verifies a random `state`, handles denial/error callbacks, has
  a 5-minute timeout, and closes on every path. Desktop-app credentials only;
  Web clients are rejected with guidance.
- Credentials and tokens are written atomically and forced to `0600`, the
  config directory to `0700`, repaired on existing installs. Corrupt token
  stores are reported instead of silently re-authorizing.
- Added `classroom.topics.readonly` and scope-drift detection during setup.
- `submit_work` no longer turns in work after a failed upload or attachment
  step, and its message is built from final state only.
- Filesystem names are normalized for Windows-invalid/reserved names.

### Fixed

- **Pagination (breaking for consumers that assumed first-page-only data).**
  Courses, coursework, submissions, materials, announcements, and topics are
  scanned to exhaustion with explicit `scanTruncated` metadata; search no
  longer silently misses later pages.
- `search` fetches only the requested kinds; endpoint failures no longer erase
  results from healthy kinds, and `errors[]` carry an `operation` label.
- `get_overview view=grades` now defaults to ACTIVE courses, matching the
  documented contract; `view=courses` still lists archived courses.
- Non-idempotent writes (`drive.files.create`, `modifyAttachments`, `turnIn`)
  are never retried; reads retry 429/5xx/network with `Retry-After` support.
- Exact ids resolve without listing; course index is cached for 45 seconds.
- MCP cancellation propagates to scans and file transfers; Google requests get
  a 60-second timeout.
- Tool input validation: whitespace queries, empty `kinds`, id+name conflicts,
  non-http links, and over-limit attachment sets fail before any Google call.
- Version comes from `package.json` instead of duplicated constants.

### Added

- CLI: `classmcp --help`, `--version`, `setup`, `serve`, `doctor`.
- `CLASSMCP_CONFIG_DIR` override; `repairSecretPermissions`.
- `scripts/pack-verify.mjs`: packs the tarball, installs it into a fresh
  project, and proves `serve` initializes and lists five tools with no
  credentials.

### Changed

- Package renamed from `classmcp` (already taken on npm) to **`gcrclassmcp`**;
  the executable remains `classmcp`. Setup never persists transient `npx`
  cache paths.
- `keytar` moved to optional dependencies; missing keychains fall back to a
  `0600` token file.
- `download_files` annotation is `idempotentHint: false` (collision policy
  creates new files); read tools are marked `openWorldHint: true`.

## [0.2.0] — 2026-09

- Rewrite to a five-tool surface: `get_overview`, `get_assignment`, `search`,
  `download_files`, `submit_work`.
- Typed `outputSchema`/`structuredContent`, MCP resources for every searchable
  kind, name autocomplete, per-file partial results, and best-effort
  submissions with `blocked` reporting.

## [0.1.0]

- Initial local prototype.
