import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { drive_v3 } from "googleapis";
import { withRetry } from "./google.js";
import { ALLOWED_ROOTS, DEFAULT_DOWNLOAD_DIR } from "./config.js";
import type { SavedFile, DownloadResult, UploadedFile } from "./schemas.js";
import { formatBytes, mapPool } from "./util.js";

const MAX_DOWNLOAD_FILES = 20;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_DOWNLOAD_FILE_BYTES = 250 * 1024 * 1024;
export const MAX_DOWNLOAD_TOTAL_BYTES = 500 * 1024 * 1024;
export const DOWNLOAD_CONCURRENCY = 3;
export const UPLOAD_CONCURRENCY = 2;
const MAX_NAME_CHARS = 120;
const COLLISION_ATTEMPTS = 100;

const EXPORT_MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
};

const GOOGLE_NATIVE: Record<string, { defaultAs: string; allowed: string[] }> = {
  "application/vnd.google-apps.document": { defaultAs: "docx", allowed: ["docx", "pdf"] },
  "application/vnd.google-apps.spreadsheet": { defaultAs: "xlsx", allowed: ["xlsx", "pdf"] },
  "application/vnd.google-apps.presentation": { defaultAs: "pptx", allowed: ["pptx", "pdf"] },
  "application/vnd.google-apps.drawing": { defaultAs: "pdf", allowed: ["pdf"] },
};

// --- Path confinement -------------------------------------------------------
// Validation is lexical AND canonical: symlinks that point outside an allowed
// root are rejected, including symlinked parents of not-yet-existing files.

function sameOrInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Canonicalize as much of `target` as exists, keeping the missing tail lexical
 * (a not-yet-created child has no symlinks yet, so appending is safe).
 */
async function canonicalizeForCheck(target: string): Promise<string> {
  let current = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length > 0 ? path.join(real, ...missing) : real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `target` and require it to be inside one of `roots`, following
 * symlinks. Returns the canonical path to operate on (never a symlink).
 */
export async function assertInsideRoots(target: string, roots: string[] = ALLOWED_ROOTS): Promise<string> {
  if (target.includes("\0")) throw new Error("Path must not contain null bytes.");
  const resolved = path.resolve(target);
  const canonicalRoots = await Promise.all(roots.map((root) => canonicalizeForCheck(root)));
  const canonicalTarget = await canonicalizeForCheck(resolved);
  const inside = canonicalRoots.some((root) => sameOrInside(root, canonicalTarget));
  if (!inside) {
    throw new Error(`Path must stay inside ${roots.join(" or ")} (got ${resolved}). Set CLASSMCP_WORKDIR to allow another directory.`);
  }
  return canonicalTarget;
}

// --- Filename portability ---------------------------------------------------

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function safeFileName(name: string): string {
  let base = path.basename(name)
    .replace(/[\\/\x00-\x1f\x7f]/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/[. ]+$/g, "");
  if (!base || base === "." || base === "..") base = "file";
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`;
  if (base.length <= MAX_NAME_CHARS) return base;
  const ext = path.extname(base).slice(0, 12);
  return base.slice(0, MAX_NAME_CHARS - ext.length) + ext;
}

/** Append an export extension unless the name already carries it. */
export function withExportExtension(base: string, ext: string): string {
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

export function exportTargetFor(
  mimeType: string | null | undefined,
  exportAs?: "pdf" | "docx" | "xlsx" | "pptx",
): { mimeType: string; ext: string } | null {
  if (!mimeType || !mimeType.startsWith("application/vnd.google-apps.")) return null;
  const native = GOOGLE_NATIVE[mimeType];
  if (!native) {
    const kind = mimeType.replace("application/vnd.google-apps.", "") || mimeType;
    throw new Error(`Google-native ${kind} cannot be downloaded; open it at its URL instead.`);
  }
  const pick = exportAs ?? native.defaultAs;
  if (!native.allowed.includes(pick)) {
    throw new Error(`Cannot export as ${pick}; valid options for this file: ${native.allowed.join(", ")}.`);
  }
  return { mimeType: EXPORT_MIME[pick], ext: pick };
}

// --- Downloading ------------------------------------------------------------

export type DownloadItem = {
  fileId: string;
  name?: string | null;
  kind: "driveFile" | "form" | "link" | "youtube";
  url?: string | null;
};

/** Open `fileName` (then "name (1).ext", …) exclusively; never follows a symlink. */
async function openExclusive(dir: string, fileName: string): Promise<{ handle: fs.FileHandle; name: string }> {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length) || "file";
  for (let attempt = 0; attempt < COLLISION_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? fileName : `${stem} (${attempt})${ext}`;
    try {
      const handle = await fs.open(path.join(dir, candidate), "wx", 0o600);
      return { handle, name: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`Could not find a free filename for "${fileName}" in ${dir}.`);
}

type DownloadBudget = { used: number; max: number };

async function streamToFile(
  source: NodeJS.ReadableStream,
  dir: string,
  fileName: string,
  maxFileBytes: number,
  budget: DownloadBudget,
): Promise<{ path: string; name: string; size: number }> {
  const { handle, name } = await openExclusive(dir, fileName);
  const destPath = path.join(dir, name);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const next = bytes + chunk.length;
      if (next > maxFileBytes) {
        callback(new Error(`Download exceeds the ${formatBytes(maxFileBytes)} per-file limit (aborted after ${formatBytes(next)}).`));
        return;
      }
      budget.used += chunk.length;
      if (budget.used > budget.max) {
        budget.used -= chunk.length;
        callback(new Error(`Download exceeds the ${formatBytes(budget.max)} per-call total limit (aborted after ${formatBytes(budget.used)}).`));
        return;
      }
      bytes = next;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, limiter, handle.createWriteStream());
    return { path: destPath, name, size: bytes };
  } catch (error) {
    budget.used -= bytes;
    await handle.close().catch(() => {});
    await fs.unlink(destPath).catch(() => {});
    throw error;
  }
}

function declaredLimitError(limit: number, actual: number): string {
  return `File exceeds the ${formatBytes(limit)} limit (would need at least ${formatBytes(actual)}); it was not downloaded.`;
}

export async function downloadMany(
  drive: drive_v3.Drive,
  files: DownloadItem[],
  opts: {
    destinationDir?: string | undefined;
    exportAs?: "pdf" | "docx" | "xlsx" | "pptx" | undefined;
    roots?: string[] | undefined;
    maxFileBytes?: number | undefined;
    maxTotalBytes?: number | undefined;
  } = {},
): Promise<DownloadResult> {
  if (files.length > MAX_DOWNLOAD_FILES) {
    throw new Error(`At most ${MAX_DOWNLOAD_FILES} files per call, got ${files.length}. Pass fileIds to select fewer.`);
  }
  const maxFileBytes = opts.maxFileBytes ?? MAX_DOWNLOAD_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_DOWNLOAD_TOTAL_BYTES;
  const destDir = await assertInsideRoots(opts.destinationDir ?? DEFAULT_DOWNLOAD_DIR, opts.roots ?? undefined);
  await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
  // Re-validate after mkdir: a symlink may have appeared mid-flight.
  await assertInsideRoots(destDir, opts.roots ?? undefined);

  const budget: DownloadBudget = { used: 0, max: maxTotalBytes };

  const saved = await mapPool(files, DOWNLOAD_CONCURRENCY, async (file): Promise<SavedFile> => {
    if (file.kind !== "driveFile") {
      return {
        name: file.name ?? file.fileId, kind: file.kind, path: null,
        url: file.url ?? null, size: null, exportedAs: null, error: null,
      };
    }
    try {
      const meta = (await withRetry(`drive.files.get ${file.fileId}`, () =>
        drive.files.get({ fileId: file.fileId, fields: "id,name,mimeType,size" }))).data;
      const target = exportTargetFor(meta.mimeType ?? null, opts.exportAs);
      const base = safeFileName(file.name ?? meta.name ?? file.fileId);
      const fileName = target ? withExportExtension(base, target.ext) : base;
      const declaredSize = meta.size != null ? Number(meta.size) : null;
      if (!target && declaredSize !== null && declaredSize > maxFileBytes) {
        throw new Error(declaredLimitError(maxFileBytes, declaredSize));
      }
      const result = target
        ? await withRetry(`drive.files.export ${file.fileId}`, () =>
            drive.files.export({ fileId: file.fileId, mimeType: target.mimeType }, { responseType: "stream" }))
        : await withRetry(`drive.files.get ${file.fileId}`, () =>
            drive.files.get({ fileId: file.fileId, alt: "media" }, { responseType: "stream" }));
      const written = await streamToFile(result.data as NodeJS.ReadableStream, destDir, fileName, maxFileBytes, budget);
      return {
        name: written.name, kind: file.kind, path: written.path, url: file.url ?? null,
        size: written.size, exportedAs: target?.ext ?? null, error: null,
      };
    } catch (error) {
      return {
        name: file.name ?? file.fileId, kind: file.kind, path: null,
        url: file.url ?? null, size: null, exportedAs: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const savedCount = saved.filter((s) => s.error === null && (s.path !== null || s.url !== null)).length;
  return { saved, savedCount, failedCount: saved.length - savedCount };
}

// --- Uploading --------------------------------------------------------------

export async function uploadLocalFile(
  drive: drive_v3.Drive,
  filePath: string,
  name?: string,
  roots?: string[],
): Promise<UploadedFile> {
  const fallbackName = name ?? path.basename(filePath);
  let handle: fs.FileHandle | undefined;
  try {
    const absolute = await assertInsideRoots(filePath, roots ?? undefined);
    handle = await fs.open(absolute, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("filePath must point to a regular file.");
    if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`filePath must be ${formatBytes(MAX_UPLOAD_BYTES)} or smaller.`);
    const response = await withRetry("drive.files.create", () => drive.files.create({
      requestBody: { name: name ?? path.basename(absolute) },
      media: { body: handle!.createReadStream({ autoClose: false }) },
      fields: "id,name,webViewLink,size",
    }));
    const data = response.data;
    return {
      name: data.name ?? fallbackName,
      id: data.id ?? null,
      webViewLink: data.webViewLink ?? null,
      size: data.size != null ? Number(data.size) : stat.size,
      error: null,
    };
  } catch (error) {
    return {
      name: fallbackName, id: null, webViewLink: null, size: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function uploadLocalFiles(
  drive: drive_v3.Drive,
  files: Array<{ path: string; name?: string }>,
  roots?: string[],
): Promise<UploadedFile[]> {
  // Uploads are non-idempotent writes, so keep concurrency conservative.
  return mapPool(files, UPLOAD_CONCURRENCY, (file) => uploadLocalFile(drive, file.path, file.name, roots));
}
