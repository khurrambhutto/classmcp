import { describe, expect, it } from "vitest";
import { validateCredentials, withRetry } from "./google.js";

describe("Google setup validation", () => {
  it("accepts installed OAuth credentials", () => {
    expect(() => validateCredentials(JSON.stringify({ installed: { client_id: "id", client_secret: "secret" } }))).not.toThrow();
  });

  it("rejects credentials without an OAuth client", () => {
    expect(() => validateCredentials("{}"))
      .toThrow("OAuth credentials must contain an installed or web client.");
  });
});

describe("withRetry", () => {
  const coded = (code: number) => Object.assign(new Error(`status ${code}`), { code });

  it("retries rate-limit failures then succeeds", async () => {
    let calls = 0;
    const result = await withRetry("test", async () => {
      calls++;
      if (calls < 3) throw coded(429);
      return "ok";
    }, 3, 1);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    await expect(withRetry("test", async () => { calls++; throw coded(400); }, 3, 1))
      .rejects.toThrow("status 400");
    expect(calls).toBe(1);
  });

  it("gives up after exhausting retries", async () => {
    let calls = 0;
    await expect(withRetry("test", async () => { calls++; throw coded(500); }, 2, 1))
      .rejects.toThrow("status 500");
    expect(calls).toBe(3);
  });
});
