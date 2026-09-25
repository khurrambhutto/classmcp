import http from "node:http";
import { google, classroom_v1, drive_v3 } from "googleapis";
import { SCOPES } from "./config.js";
import { loadCredentials, loadTokens, saveTokens } from "./store.js";

export type GoogleServices = { auth: InstanceType<typeof google.auth.OAuth2>; classroom: classroom_v1.Classroom; drive: drive_v3.Drive };

// Retry Google API calls that fail with rate-limit (429) or server (5xx) errors.
// Waits grow exponentially with jitter so parallel fan-outs do not retry in lockstep.
export async function withRetry<T>(label: string, fn: () => Promise<T>, retries = 3, baseDelayMs = 500): Promise<T> {
  let delay = baseDelayMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = (error as { code?: unknown })?.code;
      const retryable = status === 429 || (typeof status === "number" && status >= 500);
      if (!retryable || attempt >= retries) throw error;
      process.stderr.write(`classmcp: ${label} failed (status ${String(status)}), retrying in ${Math.round(delay)}ms.\n`);
      await new Promise((r) => setTimeout(r, delay + Math.random() * delay));
      delay *= 2;
    }
  }
}

export function validateCredentials(contents: string): void {
  const credentials = JSON.parse(contents) as { installed?: OAuthClient; web?: OAuthClient };
  const client = credentials.installed ?? credentials.web;
  if (!client?.client_id || !client.client_secret) throw new Error("OAuth credentials must contain an installed or web client.");
}

export async function createServices(): Promise<GoogleServices> {
  const raw = await loadCredentials();
  validateCredentials(raw);
  const credentials = JSON.parse(raw) as { installed?: OAuthClient; web?: OAuthClient };
  const client = credentials.installed ?? credentials.web;
  if (!client) throw new Error("OAuth credentials must contain an installed or web client.");
  const auth = new google.auth.OAuth2(client.client_id, client.client_secret, "http://127.0.0.1:0/oauth2callback");
  const tokens = await loadTokens();
  if (!tokens) throw new Error("Google is not connected. Run `classmcp setup` first.");
  auth.setCredentials(tokens);
  auth.on("tokens", (next) => void saveTokens({ ...tokens, ...next }));
  return { auth, classroom: google.classroom({ version: "v1", auth }), drive: google.drive({ version: "v3", auth }) };
}

export async function authorize(credentialsJson: string, openBrowser: (url: string) => Promise<void>): Promise<void> {
  const credentials = JSON.parse(credentialsJson) as { installed?: OAuthClient; web?: OAuthClient };
  validateCredentials(credentialsJson);
  const client = credentials.installed ?? credentials.web;
  if (!client?.client_id || !client.client_secret) throw new Error("Choose a Desktop app OAuth credentials JSON file.");
  const auth = new google.auth.OAuth2(client.client_id, client.client_secret, "http://127.0.0.1:53682/oauth2callback");
  const url = auth.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });
  await openBrowser(url);
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const code = new URL(request.url ?? "", "http://127.0.0.1").searchParams.get("code");
      response.end("Authentication complete. You can close this window.");
      server.close();
      if (code) resolve(code); else reject(new Error("Google OAuth callback did not contain an authorization code."));
    });
    server.listen(53682, "127.0.0.1");
  });
  const { tokens } = await auth.getToken(code);
  await saveTokens(tokens);
}

type OAuthClient = { client_id: string; client_secret: string };
