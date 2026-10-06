#!/usr/bin/env node
// Pack the project, install the tarball into a fresh project, and prove that
// the published CLI starts, reports its version, and serves exactly five MCP
// tools without any Google credentials.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const temp = mkdtempSync(path.join(os.tmpdir(), "classmcp-pack-"));
const fail = (message) => {
  throw new Error(`pack:verify: ${message}`);
};

function rpcSession(binaryCwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: binaryCwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      error ? reject(error) : resolve(stdout);
    };
    const timer = setTimeout(() => finish(new Error(`timed out waiting for tools/list; stderr: ${stderr}`)), 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (/"id":\s*2\b/.test(stdout)) finish();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", finish);
    child.on("exit", (code) => {
      if (!done) finish(new Error(`server exited early with code ${code}; stderr: ${stderr}`));
    });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pack-verify", version: "0.0.0" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" }));
  const info = packed[0];
  const paths = info.files.map((file) => file.path);
  const forbidden = paths.filter((file) => /\.(test|spec)\.|\.map$|credential|token|\.classmcp|test-report|mcp-standards|\.env/i.test(file));
  if (forbidden.length > 0) fail(`tarball contains files that must not ship: ${forbidden.join(", ")}`);
  if (!paths.includes("dist/cli.js")) fail("tarball is missing dist/cli.js");
  if (!paths.includes("README.md") || !paths.includes("LICENSE")) fail("tarball is missing README.md or LICENSE");
  console.log(`ok   packed ${info.filename} (${paths.length} files)`);

  // Content scan: a packed credential/token would be a release blocker.
  const extractDir = path.join(temp, "extract");
  mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", path.join(temp, info.filename), "-C", extractDir], { stdio: "ignore" });
  const secretPatterns = [
    [/GOCSPX-[A-Za-z0-9_-]{10,}/, "Google client secret"],
    [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, "private key"],
    [/"(refresh_token|access_token)"\s*:\s*"[A-Za-z0-9._-]{10,}"/, "OAuth token"],
    [/"type"\s*:\s*"service_account"/, "service account JSON"],
  ];
  for (const file of paths) {
    if (!/\.(js|json|md|txt|mjs|ts)$/.test(file)) continue;
    const content = readFileSync(path.join(extractDir, "package", file), "utf8");
    for (const [pattern, label] of secretPatterns) {
      if (pattern.test(content)) fail(`possible ${label} content in ${file}`);
    }
  }
  console.log("ok   tarball content scan found no secrets");

  const consumer = path.join(temp, "consumer");
  mkdirSync(consumer);
  execFileSync("npm", ["init", "-y"], { cwd: consumer, stdio: "ignore" });
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", path.join(temp, info.filename)], {
    cwd: consumer, stdio: "inherit", env: { ...process.env, npm_config_yes: "true" },
  });
  console.log("ok   tarball installed into a fresh project");

  const bin = path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "classmcp.cmd" : "classmcp");
  const version = execFileSync(bin, ["--version"], { cwd: consumer, encoding: "utf8" }).trim();
  if (version !== project.version) fail(`--version returned "${version}", expected "${project.version}"`);
  console.log(`ok   classmcp --version = ${version}`);

  const help = execFileSync(bin, ["--help"], { cwd: consumer, encoding: "utf8" });
  for (const command of ["serve", "setup", "doctor"]) {
    if (!help.includes(command)) fail(`--help does not mention ${command}`);
  }
  console.log("ok   --help lists serve/setup/doctor");

  const cliPath = path.join(consumer, "node_modules", project.name, "dist", "cli.js");
  const stdout = await rpcSession(consumer, [cliPath, "serve"]);
  for (const line of stdout.split("\n").filter(Boolean)) {
    try {
      JSON.parse(line);
    } catch {
      fail(`stdout carried non-MCP output: ${line.slice(0, 120)}`);
    }
  }
  const response = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((message) => message.id === 2);
  const tools = response?.result?.tools ?? [];
  const names = tools.map((tool) => tool.name).sort();
  const expected = ["download_files", "get_assignment", "get_overview", "search", "submit_work"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`tools/list returned ${JSON.stringify(names)}`);
  for (const tool of tools) {
    if (!tool.inputSchema || !tool.outputSchema) fail(`${tool.name} is missing inputSchema/outputSchema`);
  }
  console.log(`ok   stdio server initializes and lists 5 tools without credentials`);
  console.log("pack:verify passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
