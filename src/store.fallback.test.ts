import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Simulate a system where the native keytar binding cannot even load: the
// import throws, and the store must fall back to the 0600 token file without
// crashing module startup.
const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "classmcp-nokeytar-"));
process.env.CLASSMCP_CONFIG_DIR = configDir;

vi.mock("keytar", () => {
  throw new Error("Cannot find module 'keytar.node'");
});

const store = await import("./store.js");
const tokenFile = path.join(configDir, "tokens.json");

describe("keychain-unavailable fallback", () => {
  it("stores and loads tokens through the permission-restricted file", async () => {
    await store.saveTokens({ access_token: "at", refresh_token: "rt" });
    expect((await fs.stat(tokenFile)).mode & 0o777).toBe(0o600);
    await expect(store.loadTokens()).resolves.toMatchObject({ access_token: "at" });
    await expect(store.tokenStorage()).resolves.toBe("file");
  });

  it("reports not-configured as undefined", async () => {
    await fs.rm(tokenFile, { force: true });
    await expect(store.loadTokens()).resolves.toBeUndefined();
    await expect(store.hasStoredTokens()).resolves.toBe(false);
    await expect(store.tokenStorage()).resolves.toBe("none");
  });
});
