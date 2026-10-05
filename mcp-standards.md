# MCP Standards for classmcp

Source: Model Context Protocol docs + spec, version `2026-07-28` (current).
Docs index: https://modelcontextprotocol.io/llms.txt
Goal: make classmcp the most efficient, universal, spec-correct local Classroom server.

Classmcp today: TypeScript + `@modelcontextprotocol/sdk@^1.17.0` + zod, stdio transport,
5 tools (`get_overview`, `get_assignment`, `search`, `download_files`, `submit_work`) in
`src/server.ts`, aggregate helpers in `src/digest.ts`. Implemented: resources
(`classroom://…`), `completion/complete`, pagination, `outputSchema` +
`structuredContent` on every tool. Not implemented: prompts, tasks, `ttlMs`/caching.
Elicitation is deliberately deferred for host compatibility.

---

## 1. Protocol baseline (2026-07-28)

1. **Target `2026-07-28`, negotiate per request.** Every request carries
   `_meta.io.modelcontextprotocol/protocolVersion`; the server accepts or rejects each
   request independently. On version mismatch return `UnsupportedProtocolVersionError`
   (`-32022`) with supported versions in `data`, don't guess.
2. **Stateless.** No sessions, no per-connection state, no `initialize` handshake.
   Every request must be processable alone. Cross-call state (if ever needed) = explicit
   opaque handle passed back as an ordinary string argument (see §10).
3. **Implement `server/discover`.** Mandatory. Returns `supportedVersions`,
   `capabilities` (`tools`, `resources`, `prompts`, `completions`, extensions),
   `serverInfo { name, version }` (display only, never security input), plus a short
   `instructions` string telling the LLM how to use this server. Result is cacheable
   (`ttlMs`, `cacheScope`) — advertise ~1h, `public` if identical for all users.
4. **Back-compat probe.** A client supporting modern + legacy eras probes with
   `server/discover` first: `DiscoverResult` = modern; `UnsupportedProtocolVersionError`
   = modern but different version (retry listed version, never fall back to `initialize`);
   anything else/timeout = legacy (`initialize` handshake). classmcp is stdio + modern
   only, but must fail deterministically on legacy probes, not hang.
5. **JSON-RPC 2.0 framing.** One newline-delimited message per line, no embedded
   newlines. `_meta` required fields: `protocolVersion` + `clientCapabilities`;
   `clientInfo` recommended. Missing required `_meta` = `-32602`.

## 2. Transports: stdio is correct for classmcp

1. **Keep stdio.** Local single-client server: client spawns `node dist/cli.js serve`,
   writes requests to our stdin, reads responses from our stdout. Zero network overhead,
   OS-process isolation, works with every host (Claude Code, Cursor, OpenCode, Codex…).
2. **Stdout is sacred.** ONLY valid MCP messages on stdout. All logging → stderr
   (`console.error`, never `console.log`/`print`). One stray log line corrupts the stream.
3. **No server→client requests on stdio.** Server-initiated requests are removed in
   2026-07-28. Anything needing user input uses MRTR `InputRequiredResult` replies
   (see §8), never a request written to stdout.
4. **Lifecycle.** Exit promptly on stdin close/EOF (primary graceful-shutdown signal).
   Client shutdown = close stdin → wait → SIGTERM → SIGKILL. Unexpected exit = client
   restarts us; in-flight requests are lost, so handlers must be idempotent where possible.
   `subscriptions/listen` streams must be re-establishable.
5. **Startup budget.** Clients time out (~10–60s). NEVER block `connect()` on keychain /
   network / Google auth. Current lazy `getServices()` cached-promise pattern in
   `runServer()` is the spec-blessed approach — keep it. Connect first, authenticate on
   first tool call.
6. **Launch robustness.** Clients may start us with CWD=`/` and a minimal env. Use absolute
   paths in docs/config (`/home/…/node …/dist/cli.js`), never rely on CWD or ambient env.
   Document the `env` key for API keys. Ship `command` as absolute array (OpenCode needs
   `["/abs/node", "/abs/dist/cli.js", "serve"]`, not bare `npx`).

## 3. Primitives: tools vs resources vs prompts

| Primitive | Controlled by | Use for | classmcp mapping |
|---|---|---|---|
| **Tools** (`tools/list`, `tools/call`) | model | actions + computed queries | all 11 current tools — correct |
| **Resources** (`resources/list`, `templates/list`, `resources/read`) | application | read-only context the app attaches | ADD: `classroom://courses/{id}/syllabus`, `classroom://assignments/{id}`, resource templates per course |
| **Prompts** (`prompts/list`, `prompts/get`) | user (slash cmd) | reusable workflows | ADD: `plan-week`, `summarize-course`, `turn-in-checklist` |
| **Elicitation** (`elicitation/create` via MRTR) | user approval | missing info / confirmation | REPLACE `confirmation: z.literal(...)` with elicitation (see §8) |
| **Completion** (`completion/complete`) | app (autocomplete) | arg suggestions | ADD for `courseId` (pick from enrolled courses) |

Rule of thumb: raw upstream data the app may want to attach = resource; anything that
acts, aggregates, or needs fresh auth = tool; repeatable multi-step workflow = prompt.
Don't duplicate the same data as both a tool and a resource — link them
(tool returns `resource_link`, prompt embeds `resource`).

## 4. Tool design (the efficiency core)

1. **One tool = one operation.** Single purpose, predictable. Aggregate tools
   (`whats_due`, `whats_new`, `assignment_status`) are the reason classmcp is efficient —
   one call replaces N×course fan-out. Keep adding digests, never force the agent to loop.
2. **Names:** 1–128 chars, case-sensitive, unique per server, charset `[A-Za-z0-9_.-]`
   only (no spaces/commas). Prefer `verb_noun` snake_case (`list_assignments`,
   `turn_in_submission`). Uniqueness is per-server; federating clients prefix on collision —
   keep names specific (`classroom_…` prefix is overkill; current names are fine).
3. **Always set `title` + `description`.** `title` = human display name. `description` is
   the agent's planning doc — it MUST state: what it does, when to prefer it over siblings,
   every bound/default inline. This is what stops the `sinceDays: 90` wasted call:
   ```ts
   // BAD:  "What is new across all courses since N days ago."
   // GOOD: "New assignments/materials/announcements across ACTIVE courses since N days ago
   //        (sinceDays 0–30, default 1; limit 1–100, default 30). Prefer over looping
   //        list_assignments per course."
   ```
   Same for `whats_due` (`daysAhead 1–90 default 14`), `assignment_status`
   ("Prefer over get_assignment"), `turn_in_submission` (confirmation semantics).
4. **Schemas are JSON Schema 2020-12** (default when `$schema` omitted). `inputSchema`
   MUST be a valid object schema, never null. No-param tools:
   `{ type: "object", additionalProperties: false }` (recommended). Constrain tightly:
   `.min().max()`, enums, `format: date`, `additionalProperties: false` — Zod already
   enforces, but the schema text is what the agent reads to self-correct *before* calling.
5. **Defaults belong in the schema** (`z.…​.default()` / `.optional()` + documented
   default), so `tools/list` alone teaches correct usage with zero calls.
6. **`outputSchema` + `structuredContent` on every tool.** Today all 11 tools return only
   unstructured `text` (JSON string). Per spec, tools SHOULD also return `structuredContent`
   conforming to `outputSchema`, keeping a short human summary in `content[0].text`. This
   unlocks: client-side validation, typed code-mode wrappers (`logging_getLogs` pattern),
   and programmatic chaining without reparsing strings. Priority upgrade.
7. **Deterministic ordering.** Return `tools/list` (and items inside results) in stable
   order across requests. Enables client caching + LLM prompt-cache hits.
8. **Annotations.** Mark tools: `readOnlyHint` (all list/get/whats_*), `destructiveHint`
   (`turn_in_submission`), `idempotentHint` (reads), `openWorldHint` (anything hitting
   Google APIs). Clients use these for auto-approval policies.
9. **List tools MUST accept `cursor`** (opaque, server-chosen page size) and return
   `nextCursor` + `ttlMs` + `cacheScope`. Clients treat missing `nextCursor` as end;
   invalid cursor = `-32602`. `list_courses` paginates Google already — surface the cursor
   instead of draining all pages internally.
10. **Result envelope.** Every `tools/call` returns `resultType: "complete"` (or `"task"`
    / `"input_required"`), `content[]`, optional `structuredContent`, `isError`. Content
    blocks support `annotations { audience, priority, lastModified }` — set
    `lastModified` from Classroom `updateTime` so clients can sort/filter.

## 5. Error handling (protocol vs execution)

1. **Protocol errors** (unknown tool, malformed request, auth misconfig) = JSON-RPC
   `error { code, message }`. Models can't self-fix these; keep messages terse.
2. **Tool execution errors** (Google 429/5xx, bad date, expired handle, validation) =
   `result { resultType: "complete", content: [{ type: "text", text: "<actionable msg>" }],
   isError: true }`. Clients SHOULD feed these to the LLM for self-correction — so the
   text must say what was wrong + valid range + current value, e.g.
   `"sinceDays must be 0–30, got 90."` Never dump stack traces or tokens.
3. **Input validation failures are tool errors** (SEP-1303), not protocol errors —
   return `isError: true` with the constraint restated, so the agent retries correctly.
4. **Resource missing** = `-32602` with `{ uri }` in `data`; never an empty `contents: []`
   (ambiguous). Accept `-32002` from legacy peers.
5. **Expiry/unknown handle** (if handles are ever added) = tool error naming the handle
   as expired so the agent creates a new one.
6. classmcp gap: handlers currently `throw` raw Google errors (unhandled rejection).
   Wrap every handler: catch → classify (auth/rate-limit/not-found/validation) → return
   `isError: true` with actionable text. Add retry+backoff+jitter on 429/5xx (see §9).

## 6. Resources (add — biggest universality win)

1. Expose stable course/assignment data as resources so ANY client (even ones with weak
   tool-looping) can attach context directly:
   `classroom://courses/{courseId}/overview`, `classroom://coursework/{courseId}/{id}`,
   templates `classroom://courses/{courseId}/{kind}`.
2. Each resource: `uri` (RFC3986, custom scheme ok), `name`, `title`, `description`,
   `mimeType` (`application/json`), `size`, `annotations { audience, priority,
   lastModified }`. `resources/read` MAY return multiple `contents`; text vs `blob`
   (base64) correctly.
3. `resources/read` supports caching (§7) and MRTR input-required. `https://` URIs mean
   "client fetches directly" — for Classroom data always use `classroom://`, never proxy
   `https://classroom.google.com/…` unless the client can fetch it alone.
4. Advertise `resources { listChanged, subscribe }` capabilities independently; emit
   `notifications/resources/updated` for watched URIs via `subscriptions/listen`.
5. **Security:** validate every URI, check auth before read, sanitize paths — `file://`
   serving MUST block `../` traversal (same bug class as `download_material`'s
   `isAbsolute`-only check today — fix to confine under an allow-listed dir).

## 7. Caching + pagination + completion

1. **Caching:** every `complete` result from `server/discover`, `tools/list`,
   `prompts/list`, `resources/list`, `templates/list`, `resources/read` MUST carry
   `ttlMs >= 0` + `cacheScope`. `public` = identical for all users (tool list, prompt
   list); `private` = per-student data (everything Classroom). Cache key = method +
   params; MRTR retries (`inputResponses`/`requestState`) are NEVER cached. Any
   `list_changed` notification invalidates that cache immediately even before TTL.
   TTL is a freshness hint, not a poll interval (pollers MUST jitter+backoff).
2. **Pagination:** cursor-opaque, server-sized pages (§4.9). Each page independently
   cacheable with same `cacheScope` across pages. Cursor invalid → drop pages, refetch
   from start.
3. **Completion:** declare `completions: {}` capability; implement
   `completion/complete` for `courseId` (fuzzy match enrolled course names, ≤100 values,
   `total` + `hasMore`, sorted by relevance, rate-limited). Clients debounce + cache.

## 8. Multi-round-trip + elicitation (replace the literal-confirmation hack)

1. **MRTR replaces server-initiated requests.** `tools/call`, `prompts/get`,
   `resources/read` MAY reply `resultType: "input_required"` with `inputRequests` map
   (keys server-chosen, values `elicitation/create` | `sampling/createMessage` |
   `roots/list`) + opaque `requestState`. Client fulfills, retries with NEW `id`,
   echoing `inputResponses` + `requestState` verbatim. `requestState` is
   attacker-controlled: HMAC/AEAD-protect it when it influences auth/logic; bind
   principal + TTL + method/params digest; single-use where it matters.
2. **`turn_in_submission`: use elicitation, not `z.literal`.** The literal forces the
   agent to utter a magic string (brittle, client-specific). Instead return
   `input_required` with `elicitation/create { mode: "form", message: "Turn in <title>
   for <course>? This cannot be undone.", requestedSchema: { confirm: boolean } }`.
   Handle accept/decline/cancel distinctly (cancel = ask again later).
3. **Form mode = non-sensitive only** (flat primitives, email/uri/date formats ok).
   NEVER passwords/API keys/payment via form. **URL mode** (`mode: "url"`) for anything
   sensitive (e.g. re-OAuth): client shows full URL + domain, gets explicit consent,
   opens out-of-band (SFSafariViewController-class, never prefetch); data never transits
   the client. Servers MUST NOT put PII/creds in the elicitation URL, MUST use HTTPS,
   MUST verify the completing user == requesting user (anti-phishing).
4. **Sampling is deprecated** (2026-07-28) — never integrate LLM calls server-side;
   call provider APIs directly if needed (classmcp doesn't need this).

## 9. Efficiency: digests, batching, tasks

1. **Digest-first API is the pattern.** `whats_due` / `whats_new` / `assignment_status`
   embody the docs' guidance: minimize round trips, trim payloads (`trimText`,
   `maxDescChars`, `limit`/`pageSize`), sort server-side, return counts
   (`checkedCourses`, `openCount`, `count`) so the agent can stop early.
2. **Bounded fan-out.** Current `mapPool(…, 5)` + `pageSize ≤ 100` is right. Add:
   per-tool timeout, 429/5xx retry with exponential backoff + jitter, and partial-success
   semantics (return what succeeded + `errors[]` noting failed courses) instead of failing
   the whole aggregate on one course.
3. **Long work → Tasks extension.** If any op can exceed client timeouts (bulk downloads,
   full-semester exports), advertise `extensions: { io.modelcontextprotocol/tasks: {} }`,
   return `resultType: "task"` with `taskId` + `pollIntervalMs` + TTL, serve
   `tasks/get` / `tasks/update` (for `input_required`) / `tasks/cancel`. Only return tasks
   to clients declaring the extension. Durable task IDs survive disconnects.
4. **Progress + cancellation.** Long tools SHOULD emit `notifications/progress`; honor
   `notifications/cancelled` promptly and send nothing further for that `id`.
5. **Code-mode friendly.** `outputSchema` on every tool (§4.6) lets hosts generate typed
   sandbox stubs so multi-tool chains run without round-tripping bulk data through the
   model. Keep outputs machine-shaped (stable keys, ISO dates, numeric points).

## 10. Security checklist (local server handling student data + Drive writes)

1. Validate ALL inputs server-side (Zod is the enforcement point, descriptions are hints).
2. Sanitize outputs; never reflect tokens/creds/stack traces into results or logs.
3. Path safety: `download_material.destination` and `upload_local_file.filePath` must
   resolve inside an allow-listed directory (`path.resolve` + prefix check), not just
   `isAbsolute`. `upload` must `stat`-check isFile (already does) + cap size.
4. Least-privilege OAuth scopes; progressive elevation via `WWW-Authenticate scope=…`
   challenges rather than requesting everything up front; never log/forward tokens
   (no token passthrough — tokens issued for classmcp are never sent to Google as the
   client's, and Google tokens never go to the client).
5. Rate-limit tool invocations per tool; state handles (if added) = unguessable
   (UUIDv4), TTL-bounded, bound to authenticated user server-side, never trusted as auth.
6. Human-in-loop for destructive ops: `turn_in_submission` keeps explicit confirmation
   (via elicitation, §8) + audit log line to stderr.
7. Consent-UI rules apply to `configureClients()` auto-install: show exact command,
   no truncation, flag `sudo`/`rm -rf`/network patterns, sandbox by default.
8. SSRF/URL rules: only `http(s)` for OAuth URLs (http = loopback dev only), block
   private ranges on server-side fetches, never shell-out to open URLs, no auto-prefetch
   of elicitation URLs.

## 11. Universality: work on every host

1. Declare capabilities truthfully in `server/discover`; never vary tool/resource sets
   per connection or as side effects — per-request auth MAY filter (scopes), nothing else.
2. `serverInfo.name` is not unique — clients disambiguate by server, so keep tool names
   collision-resistant but not prefixed redundantly.
3. Deterministic tool order + `listChanged` notifications + TTLs → clients can cache and
   prompt-cache across Claude/Cursor/OpenCode/Codex/VS Code uniformly.
4. Progressive-discovery friendly: keyword-rich descriptions (course, assignment, due,
   turn-in, Drive, Classroom), group related tools, offer detail levels (digest tools =
   Layer 1 catalog, `get_assignment` = Layer 3 execute).
5. Test matrix: MCP Inspector (tools + resources + prompts tabs) → Claude Desktop/Code →
   Cursor → OpenCode (`opencode mcp list` = connected) → Codex. `server/discover` must
   answer correctly on each; stdio framing verified with raw newline-delimited JSON.

## 12. Debuggability + repo hygiene

1. stderr structured logs: `{ ts, tool, courseId?, ms, outcome }`; log startup steps,
   tool calls, errors with stack, no PII/tokens. `notifications/message` logging is
   deprecated — use stderr (stdio) / OpenTelemetry (HTTP).
2. First stop for bugs: MCP Inspector. Then client logs (`~/Library/Logs/Claude/mcp*.log`,
   `opencode` output), then config JSON validity, then `server/discover` version check
   (`-32022` = version mismatch, `-32602` = bad `_meta`/params, `-32021` = missing client
   capability like elicitation).
3. Keep `npm run build/typecheck/test` green; add: handler error-wrap tests, schema-limit
   tests (`sinceDays 31` → `isError`), path-traversal tests, Inspector CI recipe
   (`npx @modelcontextprotocol/inspector --cli …`).
4. Publish metadata: `instructions` in discover, README tool table (all 11, with bounds),
   registry entry when ready (versioned, changelog,moderation-safe — no real course data
   like `test-report-*.md` in the package).

## 13. classmcp gap list (prioritized)

1. DONE — descriptions state bounds/defaults inline (all five tools).
2. DONE — `outputSchema` + `structuredContent` on all tools (keep text summary).
3. DONE — handler try/catch → `isError: true` actionable messages + 429/5xx retry/backoff.
4. DONE — path confinement for both `download_files` destinations and
   `submit_work` upload sources (`assertInsideRoots`, tested incl. prefix-boundary
   escapes).
5. Literal `confirmTurnIn` is kept deliberately: host compatibility; elicitation
   deferred (see §8).
6. DONE — `resources` (course/assignment/material/announcement templates) +
   `completion` for every id parameter.
7. DONE — course-index caching (45s TTL, per-services dedupe, no due-state cache)
   + `instructions` in discover (first 512 chars carry workflow + submission limit).
8. DONE — `configureClients()`: OpenCode `mcp` key (not `mcpServers`), absolute
   node+dist path, show-exact-command consent; `env` documented in README.
9. DONE — README: five tools with limits; `test-report-*.md` excluded from npm files.
10. Tests: schema bounds, error envelope, traversal, digest helpers (already good).
11. Submission mutations (`modifyAttachments`/`turnIn`/`reclaim`/`patch`) are 403
    `@ProjectPermissionDenied` for third-party OAuth clients on teacher-created
    coursework — verified live 2026-09-24. The five-tool surface reflects this:
    `submit_work` = upload + best-effort + UI links; no detach/unsubmit tools
    because the API has no `removeAttachments` and `reclaim` is blocked.
12. DONE — search/reader contract (probed 2026-09-25): every kind `search` returns
    is now readable. Materials/announcements have resource templates; search hits
    carry normalized `attachments` with Drive ids (feeding `download_files`);
    the course resource is a full reader (work + materials + announcements +
    topics) instead of an `openWork` stub. Nullable enrichments carry reason
    codes (`*Status` fields) instead of bare nulls, and ACTIVE-only scans report
    `skippedArchived` + accept `includeArchived`.

## 14. 0.3.0 hardening status (2026-10-05)

All release-plan items are implemented and covered by tests:

- Canonical path confinement (`realpath`), exclusive/no-overwrite downloads,
  stream-enforced size caps, Windows-safe filenames.
- Submission sequencing: upload failure or attach failure always blocks turn-in;
  messages derive from final state; `ProjectPermissionDenied` stays best-effort.
- Pagination for courses/coursework/submissions/materials/announcements/topics
  with `scanTruncated` metadata; per-endpoint partial errors carry `operation`.
- Search fetches only requested kinds; empty `kinds` and whitespace queries are
  rejected client-side.
- OAuth lifecycle hardening (bind-first, ephemeral port, state, timeout, close),
  Desktop-only credentials, scope drift detection, atomic `0600`/`0700` secret
  storage with permission repair, dynamic keytar.
- Read-only retries with `Retry-After`; writes never retried; 60s Google
  timeouts; MCP cancellation propagation; exact-id fast paths; 45s course cache.
- Input trimming/bounds, id+name exclusivity, http(s)-only links, 20-attachment
  cap; instructions trimmed to the essential 512 chars.
- Packaging: `gcrclassmcp` name, `classmcp` command, prepack/prepublishOnly,
  tarball install + stdio smoke test with a secret content scan, CI matrix and
  tagged provenance publishing.
