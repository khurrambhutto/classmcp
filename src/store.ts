import fs from "node:fs/promises";
import path from "node:path";
import keytar from "keytar";
import { APP_NAME, CONFIG_DIR, CREDENTIALS_FILE, TOKEN_KEY } from "./config.js";

export async function saveCredentials(contents: string): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(CREDENTIALS_FILE, contents, { mode: 0o600 });
}

export async function loadCredentials(): Promise<string> {
  return fs.readFile(CREDENTIALS_FILE, "utf8");
}

export async function saveTokens(tokens: object): Promise<void> {
  const value = JSON.stringify(tokens);
  try {
    await keytar.setPassword(APP_NAME, TOKEN_KEY, value);
  } catch {
    await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(CONFIG_DIR, "tokens.json"), value, { mode: 0o600 });
    process.stderr.write("Warning: OS credential storage is unavailable; tokens are stored in ~/.classmcp/tokens.json.\n");
  }
}

export async function loadTokens(): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await keytar.getPassword(APP_NAME, TOKEN_KEY);
    if (value) return JSON.parse(value) as Record<string, unknown>;
  } catch { /* use the encrypted-store fallback below */ }
  try {
    return JSON.parse(await fs.readFile(path.join(CONFIG_DIR, "tokens.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
