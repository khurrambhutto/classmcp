import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { APP_NAME, CONFIG_DIR, CREDENTIALS_FILE, TOKEN_KEY } from "./config.js";

const TOKEN_FILE = path.join(CONFIG_DIR, "tokens.json");

// keytar is a native module: load it lazily so a missing/incompatible binding
// can never crash server startup or `classmcp --version`.
type Keytar = typeof import("keytar");
let keytarPromise: Promise<Keytar | null> | undefined;
function loadKeytar(): Promise<Keytar | null> {
  keytarPromise ??= import("keytar")
    .then((mod) => ((mod as { default?: Keytar }).default ?? (mod as unknown as Keytar)))
    .catch(() => null);
  return keytarPromise;
}

async function writeSecret(file: string, contents: string): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const temp = path.join(CONFIG_DIR, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  await fs.writeFile(temp, contents, { mode: 0o600 });
  await fs.rename(temp, file);
  // writeFile only guarantees the mode on creation, so repair both every time.
  await fs.chmod(file, 0o600).catch(() => {});
  await fs.chmod(CONFIG_DIR, 0o700).catch(() => {});
}

export async function saveCredentials(contents: string): Promise<void> {
  await writeSecret(CREDENTIALS_FILE, contents);
}

export async function loadCredentials(): Promise<string> {
  try {
    return await fs.readFile(CREDENTIALS_FILE, "utf8");
  } catch {
    throw new Error(`Google OAuth credentials not found at ${CREDENTIALS_FILE}. Run \`classmcp setup\` first.`);
  }
}

function parseTokens(raw: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Stored Google tokens are corrupt (${source}). Run \`classmcp setup\` to reconnect.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Stored Google tokens have an unexpected shape (${source}). Run \`classmcp setup\` to reconnect.`);
  }
  const tokens = parsed as Record<string, unknown>;
  if (typeof tokens.access_token !== "string" && typeof tokens.refresh_token !== "string") {
    throw new Error(`Stored Google tokens contain no credentials (${source}). Run \`classmcp setup\` to reconnect.`);
  }
  return tokens;
}

export async function saveTokens(tokens: object): Promise<void> {
  const value = JSON.stringify(tokens);
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      await keytar.setPassword(APP_NAME, TOKEN_KEY, value);
      return;
    } catch { /* fall back to the permission-restricted file */ }
  }
  await writeSecret(TOKEN_FILE, value);
  process.stderr.write("Warning: OS credential storage is unavailable; tokens are stored in ~/.classmcp/tokens.json (mode 0600).\n");
}

export async function loadTokens(): Promise<Record<string, unknown> | undefined> {
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      const value = await keytar.getPassword(APP_NAME, TOKEN_KEY);
      if (value) {
        const parsed = parseTokens(value, "OS keychain");
        if (parsed) return parsed;
      }
    } catch { /* fall back to the token file */ }
  }
  let raw: string;
  try {
    raw = await fs.readFile(TOKEN_FILE, "utf8");
  } catch {
    return undefined; // not configured
  }
  if (!raw.trim()) return undefined;
  return parseTokens(raw, TOKEN_FILE);
}

export async function hasStoredTokens(): Promise<boolean> {
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      if (await keytar.getPassword(APP_NAME, TOKEN_KEY)) return true;
    } catch { /* fall back to the token file */ }
  }
  try {
    await fs.access(TOKEN_FILE);
    return true;
  } catch {
    return false;
  }
}

export async function tokenStorage(): Promise<"keychain" | "file" | "none"> {
  const keytar = await loadKeytar();
  if (keytar) return "keychain";
  try {
    await fs.access(TOKEN_FILE);
    return "file";
  } catch {
    return "none";
  }
}

/** Repair permissions on pre-existing secret files (created before mode hardening). */
export async function repairSecretPermissions(): Promise<string[]> {
  const repaired: string[] = [];
  for (const file of [CREDENTIALS_FILE, TOKEN_FILE]) {
    try {
      const stat = await fs.stat(file);
      if ((stat.mode & 0o077) !== 0) {
        await fs.chmod(file, 0o600);
        repaired.push(file);
      }
    } catch { /* file does not exist */ }
  }
  try {
    const stat = await fs.stat(CONFIG_DIR);
    if ((stat.mode & 0o077) !== 0) {
      await fs.chmod(CONFIG_DIR, 0o700);
      repaired.push(CONFIG_DIR);
    }
  } catch { /* directory does not exist */ }
  return repaired;
}
