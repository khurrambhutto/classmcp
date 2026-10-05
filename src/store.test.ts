import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "classmcp-config-"));
process.env.CLASSMCP_CONFIG_DIR = configDir;

const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock("keytar", () => ({
  default: {
    getPassword: vi.fn(async (_service: string, account: string) => keychain.get(account) ?? null),
    setPassword: vi.fn(async (_service: string, account: string, value: string) => {
      keychain.set(account, value);
    }),
    deletePassword: vi.fn(async (_service: string, account: string) => keychain.delete(account)),
  },
}));

const store = await import("./store.js");
const { CREDENTIALS_FILE, TOKEN_KEY } = await import("./config.js");
const keytar = vi.mocked((await import("keytar")).default);
const tokenFile = path.join(configDir, "tokens.json");

async function mode(file: string): Promise<number> {
  return (await fs.stat(file)).mode & 0o777;
}

beforeEach(async () => {
  keychain.clear();
  vi.clearAllMocks();
});

describe("credential storage", () => {
  it("round-trips credentials and enforces 0600/0700 permissions", async () => {
    await store.saveCredentials('{"installed":{"client_id":"a","client_secret":"b"}}');
    await expect(store.loadCredentials()).resolves.toContain("client_id");
    expect((await mode(CREDENTIALS_FILE)).toString(8)).toBe("600");
    expect((await mode(configDir)).toString(8)).toBe("700");
  });

  it("repairs permissions on an existing secret file", async () => {
    await fs.writeFile(CREDENTIALS_FILE, "{}", { mode: 0o644 });
    await fs.chmod(CREDENTIALS_FILE, 0o644);
    const repaired = await store.repairSecretPermissions();
    expect(repaired).toContain(CREDENTIALS_FILE);
    expect((await mode(CREDENTIALS_FILE)).toString(8)).toBe("600");
  });

  it("reports a missing credentials file with setup guidance", async () => {
    await fs.rm(CREDENTIALS_FILE, { force: true });
    await expect(store.loadCredentials()).rejects.toThrow(/classmcp setup/);
  });
});

describe("token storage", () => {
  const tokens = { access_token: "at", refresh_token: "rt", scope: "s" };

  it("prefers the OS keychain and does not write a token file", async () => {
    await store.saveTokens(tokens);
    expect(keychain.get(TOKEN_KEY)).toContain("access_token");
    await expect(fs.access(tokenFile)).rejects.toThrow();
    await expect(store.loadTokens()).resolves.toMatchObject({ access_token: "at" });
    await expect(store.hasStoredTokens()).resolves.toBe(true);
    await expect(store.tokenStorage()).resolves.toBe("keychain");
  });

  it("falls back to a 0600 token file when the keychain write fails", async () => {
    keytar.setPassword.mockRejectedValueOnce(new Error("keyring unavailable"));
    await store.saveTokens(tokens);
    expect((await mode(tokenFile)).toString(8)).toBe("600");
    await expect(store.loadTokens()).resolves.toMatchObject({ refresh_token: "rt" });

    keytar.getPassword.mockResolvedValueOnce(null);
    await expect(store.loadTokens()).resolves.toMatchObject({ access_token: "at" });
  });

  it("reports not-configured as undefined rather than throwing", async () => {
    await fs.rm(tokenFile, { force: true });
    keytar.getPassword.mockResolvedValueOnce(null);
    await expect(store.loadTokens()).resolves.toBeUndefined();
    await expect(store.hasStoredTokens()).resolves.toBe(false);
    await expect(store.tokenStorage()).resolves.toBe("keychain");
  });

  it("reports a corrupt token file instead of silently reconnecting", async () => {
    await fs.writeFile(tokenFile, "{not json", { mode: 0o600 });
    keytar.getPassword.mockResolvedValueOnce(null);
    await expect(store.loadTokens()).rejects.toThrow(/corrupt/);
  });

  it("rejects a token file with no credentials", async () => {
    await fs.writeFile(tokenFile, '{"scope":"s"}', { mode: 0o600 });
    keytar.getPassword.mockResolvedValueOnce(null);
    await expect(store.loadTokens()).rejects.toThrow(/no credentials/);
  });
});
