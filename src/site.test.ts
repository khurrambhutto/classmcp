import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "./version.js";

// Guards the agent-facing docs in site/ against drifting from the code:
// agents follow llms-full.txt literally, so a stale tool name or version there
// breaks setup for them.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const server = read("./server.ts");
const tools = [...server.matchAll(/registerTool\("([a-z_]+)"/g)].map((m) => m[1]);
const llms = read("../site/llms.txt");
const full = read("../site/llms-full.txt");
const html = read("../site/index.html");

describe("site docs", () => {
  it("lists every registered tool", () => {
    expect(tools).toHaveLength(5);
    for (const tool of tools) {
      expect(full).toContain(`\`${tool}\``);
      expect(html).toContain(tool);
    }
  });

  it("states the current package version", () => {
    expect(full).toContain(VERSION);
    expect(llms).toContain(VERSION);
    expect(html).toContain(`"softwareVersion": "${VERSION}"`);
  });

  it("gives host-specific sections and the fallback rule", () => {
    for (const heading of ["## Host: Codex", "## Host: OpenCode", "## Host: Claude Code", "## Host: any other agent"]) {
      expect(full).toContain(heading);
    }
    expect(full).toMatch(/MUST read your own host's current MCP\s+documentation/);
  });

  it("points the agent prompt and llms.txt at the full guide", () => {
    const guide = "https://khurrambhutto.github.io/classmcp/llms-full.txt";
    expect(llms).toContain(guide);
    expect(html).toContain(guide);
  });
});
