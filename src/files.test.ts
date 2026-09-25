import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { drive_v3 } from "googleapis";
import { assertInsideRoots, safeFileName, exportTargetFor, downloadMany, uploadLocalFiles } from "./files.js";

function fakeDrive(handlers: {
  get?: (params: { fileId: string; alt?: string; fields?: string }) => Promise<unknown>;
  export?: () => Promise<unknown>;
  create?: () => Promise<unknown>;
}): drive_v3.Drive {
  return {
    files: {
      get: vi.fn(async (params: { fileId: string; alt?: string; fields?: string }) =>
        handlers.get ? handlers.get(params) : { data: { id: params.fileId, name: "notes.pdf", mimeType: "application/pdf", size: "12" } }),
      export: vi.fn(async () => handlers.export ? handlers.export() : { data: Readable.from(["hello"]) }),
      create: vi.fn(async () => handlers.create ? handlers.create() : { data: { id: "u1", name: "essay.docx", webViewLink: "https://drive.google.com/file/u1", size: "10" } }),
    },
  } as unknown as drive_v3.Drive;
}

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "classmcp-test-"));
}

describe("assertInsideRoots", () => {
  it("accepts a path inside a root", async () => {
    const root = await tempRoot();
    expect(assertInsideRoots(path.join(root, "sub", "file.txt"), [root])).toBe(path.join(root, "sub", "file.txt"));
  });

  it("rejects parent traversal", async () => {
    const root = await tempRoot();
    expect(() => assertInsideRoots(path.join(root, "..", "etc", "passwd"), [root])).toThrow(/must stay inside/);
  });

  it("rejects a sibling prefix that merely starts with the root name", async () => {
    const parent = await tempRoot();
    const root = path.join(parent, "Downloads");
    await fs.mkdir(root);
    expect(() => assertInsideRoots(path.join(parent, "Downloads-evil", "f.txt"), [root])).toThrow(/must stay inside/);
  });

  it("rejects null bytes and paths outside every root", () => {
    expect(() => assertInsideRoots("/etc/pass\0wd", ["/tmp/x"])).toThrow(/null bytes/);
    expect(() => assertInsideRoots("/etc/passwd", ["/tmp/x"])).toThrow(/CLASSMCP_WORKDIR/);
  });
});

describe("safeFileName", () => {
  it("strips directories and control characters", () => {
    expect(safeFileName("a/b/c.txt")).toBe("c.txt");
    expect(safeFileName("bad\u0000name\u0007.txt")).toBe("bad_name_.txt");
    expect(safeFileName("   ")).toBe("file");
    expect(safeFileName("report.final.pdf")).toBe("report.final.pdf");
  });

  it("caps very long names while keeping the extension", () => {
    const long = `${"x".repeat(200)}.pdf`;
    const result = safeFileName(long);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith(".pdf")).toBe(true);
  });
});

describe("exportTargetFor", () => {
  it("maps Google-native types to their default export", () => {
    expect(exportTargetFor("application/vnd.google-apps.document")).toEqual({
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx",
    });
    expect(exportTargetFor("application/vnd.google-apps.spreadsheet")?.ext).toBe("xlsx");
    expect(exportTargetFor("application/vnd.google-apps.presentation")?.ext).toBe("pptx");
    expect(exportTargetFor("application/vnd.google-apps.drawing")).toEqual({ mimeType: "application/pdf", ext: "pdf" });
  });

  it("honors exportAs when valid and rejects when not", () => {
    expect(exportTargetFor("application/vnd.google-apps.document", "pdf")?.ext).toBe("pdf");
    expect(() => exportTargetFor("application/vnd.google-apps.spreadsheet", "docx")).toThrow(/valid options.*xlsx, pdf/);
    expect(() => exportTargetFor("application/vnd.google-apps.form")).toThrow(/cannot be downloaded/);
  });

  it("returns null for plain binaries and unknown mime types", () => {
    expect(exportTargetFor("application/pdf")).toBeNull();
    expect(exportTargetFor(null)).toBeNull();
    expect(exportTargetFor(undefined)).toBeNull();
  });
});

describe("downloadMany", () => {
  it("saves binaries and exports Google-native files", async () => {
    const root = await tempRoot();
    const drive = fakeDrive({
      get: async ({ fileId, alt }) => {
        if (alt === "media") return { data: Readable.from(["binary-bytes"]) };
        const mime = fileId === "doc1" ? "application/vnd.google-apps.document" : "application/pdf";
        return { data: { id: fileId, name: fileId === "doc1" ? "Essay" : "notes.pdf", mimeType: mime, size: "12" } };
      },
      export: async () => ({ data: Readable.from(["docx-bytes"]) }),
    });
    const result = await downloadMany(drive, [
      { fileId: "doc1", kind: "driveFile", name: "Essay" },
      { fileId: "pdf1", kind: "driveFile", name: "notes.pdf" },
    ], { destinationDir: root, roots: [root] });

    expect(result.savedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.saved[0].path?.endsWith("Essay.docx")).toBe(true);
    expect(result.saved[0].exportedAs).toBe("docx");
    expect(result.saved[1].path?.endsWith("notes.pdf")).toBe(true);
    await expect(fs.readFile(result.saved[0].path as string, "utf8")).resolves.toBe("docx-bytes");
  });

  it("returns url rows for non-downloadable kinds and partial success on failure", async () => {
    const root = await tempRoot();
    const drive = fakeDrive({
      get: async ({ fileId, alt }) => {
        if (fileId === "bad") throw new Error("boom");
        if (alt === "media") return { data: Readable.from(["x"]) };
        return { data: { id: fileId, name: "ok.pdf", mimeType: "application/pdf", size: "1" } };
      },
    });
    const result = await downloadMany(drive, [
      { fileId: "https://example.com", kind: "link", url: "https://example.com", name: "site" },
      { fileId: "bad", kind: "driveFile" },
      { fileId: "good", kind: "driveFile" },
    ], { destinationDir: root, roots: [root] });

    expect(result.saved[0]).toMatchObject({ kind: "link", path: null, url: "https://example.com", error: null });
    expect(result.saved[1].error).toMatch(/boom/);
    expect(result.saved[2].error).toBeNull();
    expect(result.savedCount).toBe(2);
    expect(result.failedCount).toBe(1);
  });

  it("rejects more than 20 files and out-of-roots destinations", async () => {
    const root = await tempRoot();
    const drive = fakeDrive({});
    const many = Array.from({ length: 21 }, (_, i) => ({ fileId: `f${i}`, kind: "driveFile" as const }));
    await expect(downloadMany(drive, many, { destinationDir: root, roots: [root] })).rejects.toThrow(/At most 20 files/);
    await expect(downloadMany(drive, [{ fileId: "f", kind: "driveFile" }], { destinationDir: "/etc", roots: [root] })).rejects.toThrow(/must stay inside/);
  });
});

describe("uploadLocalFiles", () => {
  it("uploads files inside the roots and reports per-file errors", async () => {
    const root = await tempRoot();
    const good = path.join(root, "essay.docx");
    await fs.writeFile(good, "content");
    const drive = fakeDrive({});
    const results = await uploadLocalFiles(drive, [
      { path: good },
      { path: path.join(root, "missing.docx") },
      { path: "/etc/passwd" },
    ], [root]);

    expect(results[0]).toMatchObject({ id: "u1", error: null, name: "essay.docx" });
    expect(results[1].error).toBeTruthy();
    expect(results[2].error).toMatch(/must stay inside/);
    expect((drive.files.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
