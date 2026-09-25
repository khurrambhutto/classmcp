import os from "node:os";
import path from "node:path";

export const APP_NAME = "classmcp";
export const CONFIG_DIR = path.join(os.homedir(), ".classmcp");
export const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials.json");
export const TOKEN_KEY = "oauth-tokens";

// File tools may only touch these roots (path confinement). CLASSMCP_WORKDIR
// lets a user open a specific workspace for agent file transfers.
export const ALLOWED_ROOTS: string[] = [
  path.resolve(os.homedir(), "Downloads"),
  ...(process.env.CLASSMCP_WORKDIR ? [path.resolve(process.env.CLASSMCP_WORKDIR)] : []),
];
export const DEFAULT_DOWNLOAD_DIR = path.join(
  process.env.CLASSMCP_WORKDIR ? path.resolve(process.env.CLASSMCP_WORKDIR) : path.resolve(os.homedir(), "Downloads"),
  "classmcp",
);

export const SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
  "https://www.googleapis.com/auth/classroom.announcements.readonly",
  "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file"
];

export const CLIENT_CONFIGS = [
  { name: "Claude Code", file: path.join(os.homedir(), ".claude.json") },
  { name: "Cursor", file: path.join(os.homedir(), ".cursor", "mcp.json") },
  { name: "OpenCode", file: path.join(os.homedir(), ".config", "opencode", "opencode.jsonc") },
  { name: "Codex", file: path.join(os.homedir(), ".codex", "config.toml") },
  { name: "Antigravity", file: path.join(os.homedir(), ".config", "antigravity", "mcp.json") }
];
