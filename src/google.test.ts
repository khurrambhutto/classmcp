import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { SCOPES } from "./config.js";
import { missingScopes, statusOf, validateCredentials, waitForAuthorizationCode, withRetry } from "./google.js";

describe("Google setup validation", () => {
  it("accepts installed OAuth credentials", () => {
    expect(() => validateCredentials(JSON.stringify({ installed: { client_id: "id", client_secret: "secret" } }))).not.toThrow();
  });

  it("rejects web-only credentials with Desktop app guidance", () => {
    expect(() => validateCredentials(JSON.stringify({ web: { client_id: "id", client_secret: "secret" } })))
      .toThrow(/Desktop app/);
  });

  it("rejects credentials without an OAuth client", () => {
    expect(() => validateCredentials("{}"))
      .toThrow(/installed \(Desktop app\) client/);
  });

  it("rejects credentials that are not JSON", () => {
    expect(() => validateCredentials("not json"))
      .toThrow(/valid JSON/);
  });

  it("rejects credentials without a client secret", () => {
    expect(() => validateCredentials(JSON.stringify({ installed: { client_id: "id" } })))
      .toThrow(/installed client/);
  });
});

describe("missingScopes", () => {
  it("reports no missing scopes when the token grants everything", () => {
    expect(missingScopes({ scope: SCOPES.join(" ") })).toEqual([]);
  });

  it("detects a token issued before the topics scope was added", () => {
    const withoutTopics = SCOPES.filter((scope) => !scope.includes("topics"));
    expect(missingScopes({ scope: withoutTopics.join(" ") })).toEqual(["https://www.googleapis.com/auth/classroom.topics.readonly"]);
  });

  it("does not block older tokens that carry no scope string", () => {
    expect(missingScopes({})).toEqual([]);
    expect(missingScopes(undefined)).toEqual([]);
  });
});

describe("statusOf", () => {
  it("reads status from code, status, and response.status shapes", () => {
    expect(statusOf({ code: 403 })).toBe(403);
    expect(statusOf({ status: 429 })).toBe(429);
    expect(statusOf({ response: { status: 503 } })).toBe(503);
    expect(statusOf({ code: "500" })).toBe(500);
    expect(statusOf(new Error("no status"))).toBeUndefined();
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

  it("retries 503s surfaced only through response.status", async () => {
    let calls = 0;
    const result = await withRetry("test", async () => {
      calls++;
      if (calls === 1) throw { response: { status: 503 } };
      return "ok";
    }, 2, 1);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries transient network errors", async () => {
    let calls = 0;
    const result = await withRetry("test", async () => {
      calls++;
      if (calls === 1) throw new Error("socket hang up");
      return "ok";
    }, 2, 1);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});

function listen(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

const openServers: http.Server[] = [];
afterEach(() => {
  for (const server of openServers.splice(0)) server.close();
});

async function hit(port: number, pathname: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { connection: "close" } });
  return { status: response.status, body: await response.text() };
}

describe("waitForAuthorizationCode", () => {
  it("resolves a state-verified callback and closes the listener", async () => {
    const { server, port } = await listen();
    openServers.push(server);
    const code = waitForAuthorizationCode(server, "expected-state", 2000);
    const response = await hit(port, "/oauth2callback?code=abc123&state=expected-state");
    expect(response.status).toBe(200);
    await expect(code).resolves.toBe("abc123");
    expect(server.listening).toBe(false);
  });

  it("rejects a callback with the wrong state and closes the listener", async () => {
    const { server, port } = await listen();
    openServers.push(server);
    const code = waitForAuthorizationCode(server, "expected-state", 2000);
    const expectation = expect(code).rejects.toThrow(/valid code or state/);
    const response = await hit(port, "/oauth2callback?code=abc123&state=attacker");
    expect(response.status).toBe(400);
    await expectation;
    expect(server.listening).toBe(false);
  });

  it("reports an OAuth denial callback", async () => {
    const { server, port } = await listen();
    openServers.push(server);
    const code = waitForAuthorizationCode(server, "expected-state", 2000);
    const expectation = expect(code).rejects.toThrow(/denied \(access_denied\)/);
    await hit(port, "/oauth2callback?error=access_denied&state=expected-state");
    await expectation;
    expect(server.listening).toBe(false);
  });

  it("ignores unrelated paths until the real callback arrives", async () => {
    const { server, port } = await listen();
    openServers.push(server);
    const code = waitForAuthorizationCode(server, "s", 2000);
    const missed = await hit(port, "/favicon.ico");
    expect(missed.status).toBe(404);
    await hit(port, "/oauth2callback?code=later&state=s");
    await expect(code).resolves.toBe("later");
  });

  it("times out and closes the listener", async () => {
    const { server } = await listen();
    openServers.push(server);
    await expect(waitForAuthorizationCode(server, "s", 20)).rejects.toThrow(/Timed out/);
    expect(server.listening).toBe(false);
  });
});
