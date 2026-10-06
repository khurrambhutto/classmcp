#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import open from "open";
import { authorize, createServices, doctorScopes, validateCredentials } from "./google.js";
import { CLIENT_CONFIGS, CREDENTIALS_FILE, SCOPES } from "./config.js";
import { loadCredentials, saveCredentials, repairSecretPermissions } from "./store.js";
import { runServer } from "./server.js";
import { VERSION } from "./version.js";

const HELP = `classmcp ${VERSION} — student-side Google Classroom MCP server

Usage:
  classmcp serve        Run the MCP server over stdio (used by MCP hosts)
  classmcp setup        Store Google OAuth credentials and authorize once
  classmcp doctor       Diagnose configuration without printing secrets
  classmcp --version
  classmcp --help

Environment:
  CLASSMCP_WORKDIR    Extra directory allowed for downloads/uploads
                      (the default root is ~/Downloads)
  CLASSMCP_CONFIG_DIR Override ~/.classmcp for credentials/tokens
`;

// --- Setup ------------------------------------------------------------------

async function question(ask: (text: string) => Promise<string>, text: string): Promise<string> {
  return (await ask(text)).trim();
}

async function findCredentials(): Promise<string | undefined> {
  const downloads = path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", "Downloads");
  try {
    const files = await fs.readdir(downloads);
    const match = files.find((file) => /client_secret.*\.json$/i.test(file) || /credentials.*\.json$/i.test(file));
    return match ? path.join(downloads, match) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Never persist a transient npx cache path. If this copy of the CLI is running
 * from an npm cache, prefer the stable globally installed `classmcp` command.
 */
export function launcherCommand(argv1: string | undefined): { command: string; args: string[] } {
  const cliPath = path.resolve(argv1 ?? fileURLToPath(import.meta.url));
  const transient = /(_npx|\.npm[\\/]_cacache|node_modules[\\/]\.bin)/i.test(cliPath);
  if (transient) return { command: "classmcp", args: ["serve"] };
  return { command: process.execPath, args: [cliPath, "serve"] };
}

async function configureClients(ask: (text: string) => Promise<string>): Promise<void> {
  const launcher = launcherCommand(process.argv[1]);
  const launchLine = [launcher.command, ...launcher.args].join(" ");
  for (const client of CLIENT_CONFIGS) {
    try {
      await fs.access(path.dirname(client.file));
    } catch {
      continue;
    }
    const answer = (await question(ask, `Configure ${client.name} at ${client.file}? [y/N] `)).toLowerCase();
    if (answer !== "y") continue;

    const isOpenCode = client.name === "OpenCode" || client.file.endsWith("opencode.jsonc");
    const openCodeEntry = { type: "local", command: [launcher.command, ...launcher.args], enabled: true, timeout: 60000 };
    const jsonEntry = { command: launcher.command, args: launcher.args };
    const snippet = JSON.stringify(isOpenCode ? { mcp: { classmcp: openCodeEntry } } : { mcpServers: { classmcp: jsonEntry } }, null, 2);

    if (client.file.endsWith(".toml")) {
      console.log(
        `Add this server to ${client.file} (file not modified). Recommended:\n` +
        `  codex mcp add classmcp -- ${launchLine}\n` +
        `Or add to the TOML file:\n[mcp_servers.classmcp]\ncommand = ${JSON.stringify(launcher.command)}\nargs = [${launcher.args.map((a) => JSON.stringify(a)).join(", ")}]`,
      );
      continue;
    }
    console.log(`Command: ${launchLine}\n${snippet}`);
    let raw: string | undefined;
    try {
      raw = await fs.readFile(client.file, "utf8");
    } catch { /* missing file: created below */ }
    if (raw !== undefined) {
      try {
        JSON.parse(raw);
      } catch {
        console.log(`Could not parse ${client.file} (comments are not valid JSON). File not modified. Add manually:\n${snippet}`);
        continue;
      }
    }
    const config: Record<string, unknown> = raw !== undefined ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (isOpenCode) config.mcp = { ...((config.mcp ?? {}) as Record<string, unknown>), classmcp: openCodeEntry };
    else config.mcpServers = { ...((config.mcpServers ?? {}) as Record<string, unknown>), classmcp: jsonEntry };
    console.log(`Writing to ${client.file}.`);
    await fs.writeFile(client.file, JSON.stringify(config, null, 2) + "\n");
    console.log(`Configured ${client.name}.`);
  }
}

async function setup(): Promise<void> {
  let readline: import("node:readline/promises").Interface | undefined;
  const ask = async (text: string): Promise<string> => {
    if (!readline) {
      const { createInterface } = await import("node:readline/promises");
      readline = createInterface({ input: process.stdin, output: process.stdout });
    }
    return await readline.question(text);
  };
  try {
    console.log(`classmcp ${VERSION} setup: local Google Classroom access, no hosted service.\n`);
    const repaired = await repairSecretPermissions();
    if (repaired.length > 0) console.log(`Repaired permissions on: ${repaired.join(", ")}`);

    let file = await findCredentials();
    if (file) console.log(`Found OAuth credentials: ${file}`);
    else file = await question(ask, "OAuth credentials were not found in Downloads. Enter the JSON path: ");
    const contents = await fs.readFile(file, "utf8");
    validateCredentials(contents);
    await saveCredentials(contents);
    console.log("Credentials validated and stored locally (Desktop app client).");
    await authorize(contents, async (url) => {
      console.log(`Opening Google authorization: ${url}`);
      await open(url);
    });
    console.log("Google authorization complete.");

    const services = await createServices();
    const courses = await services.classroom.courses.list({ studentId: "me", courseStates: ["ACTIVE", "ARCHIVED"], pageSize: 100 });
    console.log(`Verification succeeded. Found ${courses.data.courses?.length ?? 0} course(s).`);
    for (const course of courses.data.courses ?? []) console.log(`- ${course.name ?? "Unnamed"} (${course.id})`);
    await configureClients(ask);
  } finally {
    readline?.close();
  }
}

// --- Doctor -----------------------------------------------------------------

async function doctor(): Promise<void> {
  const lines: string[] = [];
  let failures = 0;
  const ok = (label: string, detail?: string) => lines.push(`ok   ${label}${detail ? ` — ${detail}` : ""}`);
  const warn = (label: string, detail?: string) => lines.push(`warn ${label}${detail ? ` — ${detail}` : ""}`);
  const bad = (label: string, detail?: string) => {
    failures++;
    lines.push(`fail ${label}${detail ? ` — ${detail}` : ""}`);
  };

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node}`, "classmcp requires Node 20 or newer");

  let credentialsFound = false;
  try {
    const stat = await fs.stat(CREDENTIALS_FILE);
    credentialsFound = true;
    if ((stat.mode & 0o077) === 0) ok("OAuth credentials file permissions");
    else {
      const repaired = await repairSecretPermissions();
      warn("OAuth credentials file permissions were too open", `repaired: ${repaired.includes(CREDENTIALS_FILE) ? "yes" : "no"}`);
    }
  } catch {
    bad("OAuth credentials not found", `run \`classmcp setup\` (expected ${CREDENTIALS_FILE})`);
  }

  if (credentialsFound) {
    try {
      const contents = await loadCredentials();
      validateCredentials(contents);
      ok("OAuth credentials are a Desktop app client");
    } catch (error) {
      bad("OAuth credentials invalid", error instanceof Error ? error.message : String(error));
    }

    try {
      const scopes = await doctorScopes();
      if (!scopes.configured) {
        bad("Google tokens not found", "run `classmcp setup` to authorize");
      } else {
        ok(`Token storage: ${scopes.storage}`);
        if (scopes.missing.length === 0) ok("All required scopes granted");
        else warn("Token is missing scopes", `run \`classmcp setup\` to reauthorize: ${scopes.missing.join(", ")}`);
        try {
          const services = await createServices();
          const courses = await services.classroom.courses.list({ studentId: "me", courseStates: ["ACTIVE", "ARCHIVED"], pageSize: 1 });
          ok("Classroom API reachable", `${courses.data.courses?.length ?? 0} course(s) visible on page 1`);
          await services.drive.files.list({ pageSize: 1, fields: "files(id)" });
          ok("Drive API reachable");
        } catch (error) {
          bad("Google API call failed", error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      bad("Token check failed", error instanceof Error ? error.message : String(error));
    }
  } else {
    warn("Google API checks skipped", "credentials are not set up yet");
  }

  const hosts: string[] = [];
  for (const client of CLIENT_CONFIGS) {
    try {
      const raw = await fs.readFile(client.file, "utf8");
      hosts.push(raw.includes("classmcp") ? client.name : `${client.name} (not configured)`);
    } catch { /* host not installed */ }
  }
  if (hosts.length > 0) ok(`Host configs found: ${hosts.join(", ")}`);
  else warn("No supported host configs found", "run `classmcp setup` to configure one");

  ok("Required scopes", `${SCOPES.length} scopes`);
  console.log(lines.join("\n"));
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll checks passed.");
  }
}

// --- Entry ------------------------------------------------------------------

export async function main(argv = process.argv): Promise<void> {
  const command = (argv[2] ?? "serve").trim();
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(VERSION);
    return;
  }
  if (command === "setup") {
    await setup();
    return;
  }
  if (command === "doctor") {
    await doctor();
    return;
  }
  if (command === "serve") {
    await runServer();
    return;
  }
  console.error(`Unknown command "${command}".\n\n${HELP}`);
  process.exitCode = 1;
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
