import os from "node:os";
import path from "node:path";

export const APP_NAME = "classmcp";
export const CONFIG_DIR = path.join(os.homedir(), ".classmcp");
export const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials.json");
export const TOKEN_KEY = "oauth-tokens";

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
  { name: "OpenCode", file: path.join(os.homedir(), ".config", "opencode", "opencode.json") },
  { name: "Codex", file: path.join(os.homedir(), ".codex", "config.toml") },
  { name: "Antigravity", file: path.join(os.homedir(), ".config", "antigravity", "mcp.json") }
];
