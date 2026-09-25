#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import open from "open";
import { authorize, createServices, validateCredentials } from "./google.js";
import { CLIENT_CONFIGS, CREDENTIALS_FILE } from "./config.js";
import { loadCredentials, saveCredentials } from "./store.js";
import { runServer } from "./server.js";

const ask = readline.createInterface({ input: process.stdin, output: process.stdout });
async function question(text: string): Promise<string> { return (await ask.question(text)).trim(); }

async function findCredentials(): Promise<string | undefined> {
  const downloads = path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", "Downloads");
  try { const files = await fs.readdir(downloads); const match = files.find((file) => /client_secret.*\.json$/i.test(file) || /credentials.*\.json$/i.test(file)); return match ? path.join(downloads, match) : undefined; } catch { return undefined; }
}

async function configureClients(): Promise<void> {
  const cliPath = path.resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
  const nodeBin = process.execPath;
  for (const client of CLIENT_CONFIGS) {
    try { await fs.access(path.dirname(client.file)); } catch { continue; }
    const answer = (await question(`Configure ${client.name} at ${client.file}? [y/N] `)).toLowerCase();
    if (answer !== "y") continue;
    const openCodeEntry = { type: "local", command: [nodeBin, cliPath, "serve"], enabled: true, timeout: 60000 };
    const jsonEntry = { command: nodeBin, args: [cliPath, "serve"] };
    const isOpenCode = client.name === "OpenCode" || client.file.endsWith("opencode.jsonc");
    const snippet = JSON.stringify(isOpenCode ? { mcp: { classmcp: openCodeEntry } } : { mcpServers: { classmcp: jsonEntry } }, null, 2);
    if (client.file.endsWith(".toml")) {
      console.log(`Add this server to ${client.file} (file not modified):\n[mcp_servers.classmcp]\ncommand = ${JSON.stringify(nodeBin)}\nargs = [${JSON.stringify(cliPath)}, "serve"]`);
      continue;
    }
    console.log(`Command: ${nodeBin} ${cliPath} serve\n${snippet}`);
    let raw: string | undefined;
    try { raw = await fs.readFile(client.file, "utf8"); } catch { /* missing file: created below */ }
    if (raw !== undefined) {
      try { JSON.parse(raw); } catch {
        console.log(`Could not parse ${client.file} (comments are not valid JSON). File not modified. Add manually:\n${snippet}`);
        continue;
      }
    }
    const config: Record<string, unknown> = raw !== undefined ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (isOpenCode) config.mcp = { ...((config.mcp ?? {}) as Record<string, unknown>), classmcp: openCodeEntry };
    else config.mcpServers = { ...((config.mcpServers ?? {}) as Record<string, unknown>), classmcp: jsonEntry };
    console.log(`Writing to ${client.file}.`);
    await fs.writeFile(client.file, JSON.stringify(config, null, 2) + "\n"); console.log(`Configured ${client.name}.`);
  }
}

async function setup(): Promise<void> {
  console.log("classmcp setup: local Google Classroom access, no hosted service.\n");
  let file = await findCredentials();
  if (file) console.log(`Found OAuth credentials: ${file}`); else file = await question("OAuth credentials were not found in Downloads. Enter the JSON path: ");
  const contents = await fs.readFile(file, "utf8"); validateCredentials(contents); await saveCredentials(contents);
  console.log("Credentials validated and stored locally."); await authorize(contents, async (url) => { console.log(`Opening Google authorization: ${url}`); await open(url); });
  console.log("Google authorization complete.");
  const services = await createServices(); const courses = await services.classroom.courses.list({ studentId: "me", courseStates: ["ACTIVE", "ARCHIVED"] });
  console.log(`Verification succeeded. Found ${courses.data.courses?.length ?? 0} course(s).`); for (const course of courses.data.courses ?? []) console.log(`- ${course.name ?? "Unnamed"} (${course.id})`);
  await configureClients(); ask.close();
}

const command = process.argv[2] ?? "serve";
if (command === "setup") await setup().catch((error) => { ask.close(); console.error(`Setup failed: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
else if (command === "serve") await runServer().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
else { console.error("Usage: classmcp setup | serve"); process.exitCode = 1; }
