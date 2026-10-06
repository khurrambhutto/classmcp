import crypto from "node:crypto";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { google, classroom_v1, drive_v3 } from "googleapis";
import { z } from "zod";
import { SCOPES } from "./config.js";
import { loadCredentials, loadTokens, saveTokens, hasStoredTokens, tokenStorage } from "./store.js";

export type GoogleServices = { auth: InstanceType<typeof google.auth.OAuth2>; classroom: classroom_v1.Classroom; drive: drive_v3.Drive };

/** Every Google request gets this budget; hung sockets must not wedge a tool call. */
export const GOOGLE_TIMEOUT_MS = 60_000;

const RETRYABLE_NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|timeout/i;

/** Read an HTTP status from the shapes googleapis/gaxios actually throws. */
export function statusOf(error: unknown): number | undefined {
  const candidates = [
    (error as { status?: unknown })?.status,
    (error as { code?: unknown })?.code,
    (error as { response?: { status?: unknown } })?.response?.status,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number") return candidate;
    if (typeof candidate === "string" && /^\d{3}$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  const headers = (error as { response?: { headers?: Record<string, unknown> } })?.response?.headers
    ?? (error as { headers?: Record<string, unknown> })?.headers;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (typeof raw === "string" || typeof raw === "number") {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  }
  return undefined;
}

export function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 429) return true;
  if (status !== undefined) return status >= 500;
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_NETWORK.test(message);
}

/**
 * Retry Google API calls that fail with rate-limit (429), server (5xx), or
 * transient network errors. Honors Retry-After. Reads only: callers must not
 * wrap non-idempotent writes (drive.files.create, modifyAttachments, turnIn).
 */
export async function withRetry<T>(label: string, fn: () => Promise<T>, retries = 3, baseDelayMs = 500): Promise<T> {
  let delayMs = baseDelayMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error) || attempt >= retries) throw error;
      const wait = retryAfterMs(error) ?? Math.round(delayMs + Math.random() * delayMs);
      process.stderr.write(`classmcp: ${label} failed (${statusOf(error) ?? "network"}), retrying in ${wait}ms.\n`);
      await delay(wait);
      delayMs *= 2;
    }
  }
}

// --- Credentials ------------------------------------------------------------

const OAuthClientSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
});

const CredentialsSchema = z.object({
  installed: OAuthClientSchema.optional(),
  web: OAuthClientSchema.optional(),
});

export function parseCredentials(contents: string): { installed?: OAuthClient; web?: OAuthClient } {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch {
    throw new Error("OAuth credentials must be valid JSON (download the Desktop app client JSON from Google Cloud Console).");
  }
  const parsed = CredentialsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("OAuth credentials must contain an installed client with client_id and client_secret.");
  }
  return parsed.data;
}

/** Desktop/installed clients only: the authorization-code flow used here is a loopback Desktop flow. */
export function validateCredentials(contents: string): void {
  const credentials = parseCredentials(contents);
  if (!credentials.installed) {
    if (credentials.web) {
      throw new Error(
        "This is a Web application OAuth client, which this local server does not support. " +
        "In Google Cloud Console create an OAuth client ID of type \"Desktop app\" and use that JSON.",
      );
    }
    throw new Error("OAuth credentials must contain an installed (Desktop app) client.");
  }
}

export function missingScopes(tokens: Record<string, unknown> | undefined): string[] {
  const granted = typeof tokens?.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : [];
  if (granted.length === 0) return []; // Older tokens may not carry scope; do not block them.
  return SCOPES.filter((scope) => !granted.includes(scope));
}

export async function createServices(): Promise<GoogleServices> {
  const raw = await loadCredentials();
  validateCredentials(raw);
  const credentials = parseCredentials(raw);
  const client = credentials.installed;
  if (!client) throw new Error("OAuth credentials must contain an installed (Desktop app) client.");
  // Per-request timeout for every generated client (hangs must never wedge a tool call).
  google.options({ timeout: GOOGLE_TIMEOUT_MS });
  // The redirect URI is fixed per authorization and is not sent on refresh.
  const auth = new google.auth.OAuth2(client.client_id, client.client_secret, "http://127.0.0.1/oauth2callback");
  const tokens = await loadTokens();
  if (!tokens) throw new Error("Google is not connected. Run `classmcp setup` first.");
  const missing = missingScopes(tokens);
  if (missing.length > 0) {
    process.stderr.write(`classmcp: stored token is missing scope(s): ${missing.join(", ")}. Run \`classmcp setup\` to reauthorize.\n`);
  }
  auth.setCredentials(tokens);
  auth.on("tokens", (next) => void saveTokens({ ...tokens, ...next }));
  return { auth, classroom: google.classroom({ version: "v1", auth }), drive: google.drive({ version: "v3", auth }) };
}

// --- OAuth authorization ----------------------------------------------------

const CALLBACK_PATH = "/oauth2callback";
export const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

function listenLoopback(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine the OAuth callback port."));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

export function waitForAuthorizationCode(server: http.Server, expectedState: string, timeoutMs = AUTH_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (conclude: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      conclude();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the Google authorization callback.`))),
      timeoutMs,
    );
    server.on("error", (error) => finish(() => reject(error)));
    server.on("request", (request, response) => {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://127.0.0.1");
      } catch {
        response.statusCode = 400;
        response.end("Bad request.");
        return;
      }
      if (url.pathname !== CALLBACK_PATH) {
        response.statusCode = 404;
        response.end("Not found.");
        return; // keep waiting for the real callback
      }
      const oauthError = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (oauthError) {
        response.end("Authorization was denied. You can close this window.");
        finish(() => reject(new Error(`Google authorization was denied (${oauthError}).`)));
        return;
      }
      if (!code || state !== expectedState) {
        response.statusCode = 400;
        response.end("Invalid authorization callback. You can close this window.");
        finish(() => reject(new Error("The OAuth callback was missing a valid code or state; the request was rejected.")));
        return;
      }
      response.end("Authorization complete. You can close this window.");
      finish(() => resolve(code));
    });
  });
}

/**
 * Bind the loopback listener first, then open the browser. State-verified,
 * timed out, and closed on every path.
 */
export async function authorize(credentialsJson: string, openBrowser: (url: string) => Promise<void>): Promise<void> {
  const credentials = parseCredentials(credentialsJson);
  validateCredentials(credentialsJson);
  const client = credentials.installed;
  if (!client) throw new Error("Choose a Desktop app OAuth credentials JSON file.");

  const state = crypto.randomBytes(24).toString("hex");
  const { server, port } = await listenLoopback();
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const auth = new google.auth.OAuth2(client.client_id, client.client_secret, redirectUri);
  const url = auth.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent", state });

  const waiting = waitForAuthorizationCode(server, state);
  try {
    await openBrowser(url);
  } catch (error) {
    server.close();
    throw new Error(
      `Could not open a browser (${error instanceof Error ? error.message : String(error)}). ` +
      `Open this URL manually in any browser, then rerun \`classmcp setup\` and paste the credentials path when asked:\n${url}`,
    );
  }

  const code = await waiting;
  const { tokens } = await auth.getToken(code);
  if (!tokens || typeof tokens !== "object") throw new Error("Google did not return tokens; authorization failed.");
  await saveTokens(tokens as Record<string, unknown>);
}

export async function doctorScopes(): Promise<{ configured: boolean; missing: string[]; storage: "keychain" | "file" | "none" }> {
  const storage = await tokenStorage();
  if (!(await hasStoredTokens())) return { configured: false, missing: [], storage };
  const tokens = await loadTokens().catch(() => undefined);
  return { configured: true, missing: missingScopes(tokens), storage };
}

type OAuthClient = { client_id: string; client_secret: string };
