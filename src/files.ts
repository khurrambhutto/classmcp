import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { drive_v3 } from "googleapis";
import { withRetry } from "./google.js";
import { ALLOWED_ROOTS, DEFAULT_DOWNLOAD_DIR } from "./config.js";
import type { SavedFile, DownloadResult, UploadedFile } from "./schemas.js";

const MAX_DOWNLOAD_FILES = 20;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

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

export function assertInsideRoots(target: string, roots: string[] = ALLOWED_ROOTS): string {
  if (target.includes("\0")) throw new Error("Path must not contain null bytes.");
  const resolved = path.resolve(target);
  const inside = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!inside) {
    throw new Error(`Path must stay inside ${roots.join(" or ")} (got ${resolved}). Set CLASSMCP_WORKDIR to allow another directory.`);
  }
  return resolved;
}

export function safeFileName(name: string): string {
  const base = path.basename(name)
    .replace(/[\\/\x00-\x1f\x7f]/g, "_")
    .trim();
  const cleaned = base.replace(/^_+|_+$/g, "") || "file";
  if (cleaned.length <= 120) return cleaned;
  const ext = path.extname(cleaned).slice(0, 12);
  return cleaned.slice(0, 120 - ext.length) + ext;
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

export type DownloadItem = {
  fileId: string;
  name?: string | null;
  kind: "driveFile" | "form" | "link" | "youtube";
  url?: string | null;
};

export async function downloadMany(
  drive: drive_v3.Drive,
  files: DownloadItem[],
  opts: {
    destinationDir?: string | undefined;
    exportAs?: "pdf" | "docx" | "xlsx" | "pptx" | undefined;
    roots?: string[] | undefined;
  } = {},
): Promise<DownloadResult> {
  if (files.length > MAX_DOWNLOAD_FILES) {
    throw new Error(`At most ${MAX_DOWNLOAD_FILES} files per call, got ${files.length}. Pass fileIds to select fewer.`);
  }
  const destDir = assertInsideRoots(opts.destinationDir ?? DEFAULT_DOWNLOAD_DIR, opts.roots ?? undefined);
  const saved: SavedFile[] = [];
  for (const file of files) {
    if (file.kind !== "driveFile") {
      saved.push({
        name: file.name ?? file.fileId, kind: file.kind, path: null,
        url: file.url ?? null, size: null, exportedAs: null, error: null,
      });
      continue;
    }
    try {
      const meta = (await withRetry(`drive.files.get ${file.fileId}`, () =>
        drive.files.get({ fileId: file.fileId, fields: "id,name,mimeType,size" }))).data;
      const target = exportTargetFor(meta.mimeType ?? null, opts.exportAs);
      const base = safeFileName(file.name ?? meta.name ?? file.fileId);
      const fileName = target ? `${base}.${target.ext}` : base;
      await fs.mkdir(destDir, { recursive: true });
      const dest = path.join(destDir, fileName);
      const result = target
        ? await withRetry(`drive.files.export ${file.fileId}`, () =>
            drive.files.export({ fileId: file.fileId, mimeType: target.mimeType }, { responseType: "stream" }))
        : await withRetry(`drive.files.get ${file.fileId}`, () =>
            drive.files.get({ fileId: file.fileId, alt: "media" }, { responseType: "stream" }));
      try {
        await pipeline(result.data as NodeJS.ReadableStream, createWriteStream(dest));
      } catch (error) {
        await fs.unlink(dest).catch(() => {});
        throw error;
      }
      saved.push({
        name: fileName, kind: file.kind, path: dest, url: file.url ?? null,
        size: meta.size != null ? Number(meta.size) : null,
        exportedAs: target?.ext ?? null, error: null,
      });
    } catch (error) {
      saved.push({
        name: file.name ?? file.fileId, kind: file.kind, path: null,
        url: file.url ?? null, size: null, exportedAs: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const savedCount = saved.filter((s) => s.error === null && (s.path !== null || s.url !== null)).length;
  return { saved, savedCount, failedCount: saved.length - savedCount };
}

export async function uploadLocalFile(
  drive: drive_v3.Drive,
  filePath: string,
  name?: string,
  roots?: string[],
): Promise<UploadedFile> {
  const fallbackName = name ?? path.basename(filePath);
  try {
    const absolute = assertInsideRoots(filePath, roots ?? undefined);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error("filePath must point to a file.");
    if (stat.size > MAX_UPLOAD_BYTES) throw new Error("filePath must be 100 MB or smaller.");
    const response = await withRetry("drive.files.create", () => drive.files.create({
      requestBody: { name: name ?? path.basename(absolute) },
      media: { body: createReadStream(absolute) },
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
  }
}

export async function uploadLocalFiles(
  drive: drive_v3.Drive,
  files: Array<{ path: string; name?: string }>,
  roots?: string[],
): Promise<UploadedFile[]> {
  const out: UploadedFile[] = [];
  for (const file of files) {
    out.push(await uploadLocalFile(drive, file.path, file.name, roots));
  }
  return out;
}
