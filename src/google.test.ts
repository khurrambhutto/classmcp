import { describe, expect, it } from "vitest";
import { validateCredentials } from "./google.js";

describe("Google setup validation", () => {
  it("accepts installed OAuth credentials", () => {
    expect(() => validateCredentials(JSON.stringify({ installed: { client_id: "id", client_secret: "secret" } }))).not.toThrow();
  });

  it("rejects credentials without an OAuth client", () => {
    expect(() => validateCredentials("{}"))
      .toThrow("OAuth credentials must contain an installed or web client.");
  });
});
