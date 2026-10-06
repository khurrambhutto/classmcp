import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { drive_v3 } from "googleapis";
import {
  assertInsideRoots, safeFileName, withExportExtension, exportTargetFor, downloadMany, uploadLocalFiles,
} from "./files.js";

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
  it("accepts a path inside a root and returns the canonical path", async () => {
    const root = await tempRoot();
    const expected = path.join(await fs.realpath(root), "sub", "file.txt");
    await expect(assertInsideRoots(path.join(root, "sub", "file.txt"), [root])).resolves.toBe(expected);
  });

  it("rejects parent traversal", async () => {
    const root = await tempRoot();
    await expect(assertInsideRoots(path.join(root, "..", "etc", "passwd"), [root])).rejects.toThrow(/must stay inside/);
  });

  it("rejects a sibling prefix that merely starts with the root name", async () => {
    const parent = await tempRoot();
    const root = path.join(parent, "Downloads");
    await fs.mkdir(root);
    await expect(assertInsideRoots(path.join(parent, "Downloads-evil", "f.txt"), [root])).rejects.toThrow(/must stay inside/);
  });

  it("rejects null bytes and paths outside every root", async () => {
    await expect(assertInsideRoots("/etc/pass\0wd", ["/tmp/x"])).rejects.toThrow(/null bytes/);
    await expect(assertInsideRoots("/etc/passwd", ["/tmp/x"])).rejects.toThrow(/CLASSMCP_WORKDIR/);
  });

  it("rejects an existing file that is a symlink out of the root", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const target = path.join(outside, "secret.txt");
    await fs.writeFile(target, "secret");
    const link = path.join(root, "escape.txt");
    await fs.symlink(target, link);
    await expect(assertInsideRoots(link, [root])).rejects.toThrow(/must stay inside/);
  });

  it("rejects a not-yet-existing file under a symlinked parent out of the root", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await fs.symlink(outside, path.join(root, "escape-dir"));
    await expect(assertInsideRoots(path.join(root, "escape-dir", "new.txt"), [root])).rejects.toThrow(/must stay inside/);
  });

  it("allows a symlink that stays inside the root", async () => {
    const root = await tempRoot();
    const real = path.join(root, "real");
    await fs.mkdir(real);
    await fs.symlink(real, path.join(root, "link"));
    await expect(assertInsideRoots(path.join(root, "link", "f.txt"), [root])).resolves.toBe(path.join(real, "f.txt"));
  });
});

describe("safeFileName", () => {
  it("strips directories and control characters", () => {
    expect(safeFileName("a/b/c.txt")).toBe("c.txt");
    expect(safeFileName("bad\u0000name\u0007.txt")).toBe("bad_name_.txt");
    expect(safeFileName("   ")).toBe("file");
    expect(safeFileName("report.final.pdf")).toBe("report.final.pdf");
  });

  it("normalizes Windows-invalid and reserved names", () => {
    expect(safeFileName('rep<ort>:"|?*.pdf')).toBe("rep_ort______.pdf");
    expect(safeFileName("CON")).toBe("_CON");
    expect(safeFileName("com1.txt")).toBe("_com1.txt");
    expect(safeFileName("trailing. ")).toBe("trailing");
    expect(safeFileName("lpt9")).toBe("_lpt9");
  });

  it("caps very long names while keeping the extension", () => {
    const long = `${"x".repeat(200)}.pdf`;
    const result = safeFileName(long);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith(".pdf")).toBe(true);
  });
});

describe("withExportExtension", () => {
  it("does not duplicate an extension the name already carries", () => {
    expect(withExportExtension("Essay.docx", "docx")).toBe("Essay.docx");
    expect(withExportExtension("Essay", "docx")).toBe("Essay.docx");
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

  it("preserves input order under bounded concurrency", async () => {
    const root = await tempRoot();
    const drive = fakeDrive({
      get: async ({ fileId, alt }) => {
        if (alt === "media") {
          await new Promise((r) => setTimeout(r, fileId === "slow" ? 20 : 1));
          return { data: Readable.from([`bytes-${fileId}`]) };
        }
        return { data: { id: fileId, name: `${fileId}.bin`, mimeType: "application/octet-stream", size: "5" } };
      },
    });
    const result = await downloadMany(drive, [
      { fileId: "slow", kind: "driveFile" },
      { fileId: "fast", kind: "driveFile" },
    ], { destinationDir: root, roots: [root] });
    expect(result.saved.map((s) => s.name)).toEqual(["slow.bin", "fast.bin"]);
  });

  it("rejects more than 20 files and out-of-roots destinations", async () => {
    const root = await tempRoot();
    const drive = fakeDrive({});
    const many = Array.from({ length: 21 }, (_, i) => ({ fileId: `f${i}`, kind: "driveFile" as const }));
    await expect(downloadMany(drive, many, { destinationDir: root, roots: [root] })).rejects.toThrow(/At most 20 files/);
    await expect(downloadMany(drive, [{ fileId: "f", kind: "driveFile" }], { destinationDir: "/etc", roots: [root] })).rejects.toThrow(/must stay inside/);
  });

  it("rejects a symlinked destination directory that escapes the roots", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await fs.symlink(outside, path.join(root, "escape"));
    const drive = fakeDrive({});
    await expect(downloadMany(drive, [{ fileId: "f", kind: "driveFile" }], { destinationDir: path.join(root, "escape"), roots: [root] }))
      .rejects.toThrow(/must stay inside/);
  });

  it("never follows a destination symlink and never overwrites an existing file", async () => {
    const root = await tempRoot();
    const victim = path.join(root, "victim.txt");
    await fs.writeFile(victim, "original");
    // A symlink named like the download target pointing at the victim.
    await fs.symlink(victim, path.join(root, "notes.pdf"));
    const drive = fakeDrive({ get: async ({ fileId, alt }) => {
      if (alt === "media") return { data: Readable.from(["new-bytes"]) };
      return { data: { id: fileId, name: "notes.pdf", mimeType: "application/pdf", size: "9" } };
    } });
    const result = await downloadMany(drive, [{ fileId: "f", kind: "driveFile" }], { destinationDir: root, roots: [root] });

    expect(result.savedCount).toBe(1);
    expect(path.basename(result.saved[0].path as string)).toBe("notes (1).pdf");
    await expect(fs.readFile(victim, "utf8")).resolves.toBe("original");
    expect(await fs.readFile(path.join(root, "notes.pdf"), "utf8")).toBe("original");
  });

  it("removes the partial file when a stream fails", async () => {
    const root = await tempRoot();
    const failing = new Readable({
      read() {
        this.push("partial");
        this.destroy(new Error("connection reset"));
      },
    });
    const drive = fakeDrive({ get: async ({ alt }) => {
      if (alt === "media") return { data: failing };
      return { data: { id: "f", name: "notes.pdf", mimeType: "application/pdf", size: "100" } };
    } });
    const result = await downloadMany(drive, [{ fileId: "f", kind: "driveFile" }], { destinationDir: root, roots: [root] });
    expect(result.failedCount).toBe(1);
    expect(result.saved[0].error).toMatch(/connection reset/);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("enforces the per-file byte limit while streaming and removes the partial file", async () => {
    const root = await tempRoot();
    const drive = fakeDrive({ get: async ({ alt }) => {
      if (alt === "media") return { data: Readable.from([Buffer.alloc(64)]) };
      return { data: { id: "f", name: "big.bin", mimeType: "application/octet-stream", size: null } };
    } });
    const result = await downloadMany(drive, [{ fileId: "f", kind: "driveFile" }], {
      destinationDir: root, roots: [root], maxFileBytes: 32,
    });
    expect(result.failedCount).toBe(1);
    expect(result.saved[0].error).toMatch(/32 B per-file limit/);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("enforces the total byte limit across files", async () => {
    const root = await tempRoot();
    const drive = fakeDrive({ get: async ({ fileId, alt }) => {
      if (alt === "media") return { data: Readable.from([Buffer.alloc(40)]) };
      return { data: { id: fileId, name: `${fileId}.bin`, mimeType: "application/octet-stream", size: null } };
    } });
    const result = await downloadMany(drive, [
      { fileId: "a", kind: "driveFile" },
      { fileId: "b", kind: "driveFile" },
      { fileId: "c", kind: "driveFile" },
    ], { destinationDir: root, roots: [root], maxTotalBytes: 100, maxFileBytes: 1000 });
    expect(result.savedCount).toBe(2);
    expect(result.failedCount).toBe(1);
    const failed = result.saved.find((s) => s.error);
    expect(failed?.error).toMatch(/limit/);
  });

  it("rejects an over-limit declared size before downloading", async () => {
    const root = await tempRoot();
    const drive = fakeDrive({ get: async ({ fileId }) => ({
      data: { id: fileId, name: "huge.bin", mimeType: "application/octet-stream", size: String(200) },
    }) });
    const result = await downloadMany(drive, [{ fileId: "f", kind: "driveFile" }], {
      destinationDir: root, roots: [root], maxFileBytes: 100,
    });
    expect(result.failedCount).toBe(1);
    expect(result.saved[0].error).toMatch(/100 B limit/);
    expect((drive.files.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("stops before fetching anything when the call is already cancelled", async () => {
    const root = await tempRoot();
    const controller = new AbortController();
    controller.abort();
    const drive = fakeDrive({});
    await expect(downloadMany(drive, [{ fileId: "f", kind: "driveFile" }], {
      destinationDir: root, roots: [root], signal: controller.signal,
    })).rejects.toThrow(/cancelled/);
    expect((drive.files.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(await fs.readdir(root)).toEqual([]);
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

  it("refuses to upload through a symlink that escapes the roots", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "secret");
    const link = path.join(root, "innocent.txt");
    await fs.symlink(secret, link);
    const drive = fakeDrive({});
    const results = await uploadLocalFiles(drive, [{ path: link }], [root]);
    expect(results[0].error).toMatch(/must stay inside/);
    expect(drive.files.create as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("preserves input order under bounded concurrency", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "a.txt"), "a");
    await fs.writeFile(path.join(root, "b.txt"), "b");
    await fs.writeFile(path.join(root, "c.txt"), "c");
    let n = 0;
    const drive = fakeDrive({ create: async () => ({ data: { id: `u${++n}`, name: "x", webViewLink: null, size: "1" } }) });
    const results = await uploadLocalFiles(drive, [
      { path: path.join(root, "a.txt") },
      { path: path.join(root, "b.txt") },
      { path: path.join(root, "c.txt") },
    ], [root]);
    expect(results.map((r) => r.error)).toEqual([null, null, null]);
    expect((drive.files.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("honors cancellation without calling Drive", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "a.txt"), "a");
    const controller = new AbortController();
    controller.abort();
    const drive = fakeDrive({});
    const results = await uploadLocalFiles(drive, [{ path: path.join(root, "a.txt") }], [root], controller.signal);
    expect(results[0].error).toMatch(/cancelled/);
    expect(drive.files.create as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("never retries a failed upload (non-idempotent write)", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "a.txt"), "a");
    const drive = fakeDrive({ create: async () => { throw Object.assign(new Error("server error"), { code: 500 }); } });
    const results = await uploadLocalFiles(drive, [{ path: path.join(root, "a.txt") }], [root]);
    expect(results[0].error).toMatch(/server error/);
    expect((drive.files.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
