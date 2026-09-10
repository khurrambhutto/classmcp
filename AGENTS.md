# AGENTS.md

Local Google Classroom MCP server. TypeScript, Node >= 20.

Run `npm run build`, `npm run typecheck`, `npm run test` before finishing.

## Solved issues

### OpenCode shows classmcp as failed / timed out

Cause was `runServer` awaiting `createServices()` before `server.connect()`. Imports plus keychain plus auth made startup take 10s+, OpenCode gave up.

Fix in `src/server.ts`: connect first, load Google lazily per tool call with a cached `getServices()` factory. Keep it that way. Verify with `opencode mcp list`, expect `classmcp connected`.

### OpenCode does not pick up classmcp

- OpenCode v1.18 uses `mcp`, not `mcpServers`. Entry lives in `~/.config/opencode/opencode.jsonc`.
- Command must be an array with an absolute node path, pointing at the local build. Delete the stale `~/.config/opencode/opencode.json` that used the old `mcpServers` plus `npx classmcp@0.1.0` form.
- Working entry: `classmcp` type `local`, command `["/home/khurram/.local/share/mise/installs/node/26.7.0/bin/node", "/home/khurram/Projects/classmcp/dist/cli.js", "serve"]`, enabled true, timeout 60000.

### Calling classmcp tools from an agent

Call ClassMCP tools inside the `execute` code runtime with bracket notation. `tools.classmcp.list_courses({})` fails with unknown tool. Use `tools.classmcp["list_courses"]({})`.
