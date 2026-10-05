import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One canonical source of truth: the published package.json, which sits one
// directory above dist/ (or src/ in development).
function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();
