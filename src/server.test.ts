import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GoogleServices } from "./google.js";
import { buildServer } from "./server.js";

function datePlus(days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.now() + days * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const PROJECT_DENIED = new Error("@ProjectPermissionDenied The Developer Console project is not permitted to make this request.");

function makeServices(overrides: { denyWrites?: boolean; uploadError?: Error; attachError?: Error } = {}) {
  const courses = [
    { id: "c1", name: "Physics 101", section: "A", courseState: "ACTIVE" },
    { id: "c2", name: "Physics 102", section: "B", courseState: "ACTIVE" },
    { id: "c3", name: "Chemistry", section: "C", courseState: "ARCHIVED" },
  ];
  const work: Record<string, unknown[]> = {
    c1: [
      {
        id: "w1", title: "Essay on waves", description: "Write about interference and diffraction.",
        state: "PUBLISHED", workType: "ASSIGNMENT", maxPoints: 100,
        alternateLink: "https://classroom.google.com/c/c1/w1",
        dueDate: datePlus(3), dueTime: { hours: 23, minutes: 59 },
        materials: [{ driveFile: { driveFile: { id: "t1", title: "handout.pdf" } } }],
        updateTime: new Date().toISOString(), creationTime: new Date().toISOString(),
      },
      {
        id: "w2", title: "Done task", description: "Already submitted.", state: "PUBLISHED",
        workType: "ASSIGNMENT", maxPoints: 50, alternateLink: "https://classroom.google.com/c/c1/w2",
        dueDate: datePlus(1), updateTime: new Date().toISOString(),
      },
    ],
    c2: [{ id: "w3", title: "Midterm notes", description: "Reading list.", state: "PUBLISHED", workType: "ASSIGNMENT", maxPoints: 10, updateTime: new Date().toISOString() }],
    c3: [{ id: "w4", title: "Archived task", description: "Old work.", state: "PUBLISHED", workType: "ASSIGNMENT", maxPoints: 10, dueDate: datePlus(2), updateTime: new Date().toISOString() }],
  };
  const subs: Record<string, unknown[]> = {
    c1: [
      { id: "s1", courseWorkId: "w1", state: "CREATED", late: false, assignmentSubmission: { attachments: [{ driveFile: { id: "d1", title: "notes.pdf" } }] } },
      { courseWorkId: "w2", state: "TURNED_IN", late: false },
    ],
    c2: [],
    c3: [{ id: "s4", courseWorkId: "w4", state: "CREATED", late: false }],
  };
  const modifyAttachments = vi.fn(async () => {
    if (overrides.attachError) throw overrides.attachError;
    if (overrides.denyWrites !== false) throw PROJECT_DENIED;
    return { data: {} };
  });
  const turnIn = vi.fn(async () => {
    if (overrides.denyWrites !== false) throw PROJECT_DENIED;
    return { data: {} };
  });
  const services = {
    classroom: {
      courses: {
        list: vi.fn(async (params: { courseStates?: string[] }) => ({
          data: { courses: courses.filter((c) => (params.courseStates ?? []).includes(c.courseState)) },
        })),
        get: vi.fn(async (params: { id: string }) => {
          const found = courses.find((c) => c.id === params.id);
          if (!found) throw new Error("Requested entity was not found.");
          return { data: found };
        }),
        courseWork: {
          list: vi.fn(async (params: { courseId: string }) => ({ data: { courseWork: work[params.courseId] ?? [] } })),
          get: vi.fn(async (params: { courseId: string; id: string }) => {
            const found = (work[params.courseId] ?? []).find((w) => (w as { id: string }).id === params.id);
            if (!found) throw new Error("Requested entity was not found.");
            return { data: found };
          }),
          rubrics: { list: vi.fn(async () => ({ data: {} })) },
          studentSubmissions: {
            list: vi.fn(async (params: { courseId: string }) => ({ data: { studentSubmissions: subs[params.courseId] ?? [] } })),
            get: vi.fn(async () => ({ data: { submissionHistory: [{ stateHistory: { state: "CREATED", stateTimestamp: "2026-09-01T00:00:00Z" } }] } })),
            modifyAttachments,
            turnIn,
          },
        },
        topics: {
          get: vi.fn(async () => ({ data: { topicId: "t-opic", name: "Unit 1" } })),
          list: vi.fn(async () => ({ data: { topic: [{ topicId: "t-opic", name: "Unit 1" }] } })),
        },
        courseWorkMaterials: {
          list: vi.fn(async (params: { courseId: string }) => ({ data: { courseWorkMaterial: params.courseId === "c1" ? [{ id: "m1", title: "Slides", description: "Chapter 1 slides about waves", materials: [{ driveFile: { driveFile: { id: "t9", title: "slides.pdf" } } }], updateTime: new Date().toISOString(), alternateLink: "https://classroom.google.com/c/c1/m1" }] : [] } })),
          get: vi.fn(async (params: { id: string }) => {
            if (params.id !== "m1") throw new Error("Requested entity was not found.");
            return { data: { id: "m1", title: "Slides", description: "Chapter 1 slides about waves", materials: [{ driveFile: { driveFile: { id: "t9", title: "slides.pdf" } } }], updateTime: new Date().toISOString(), creationTime: new Date().toISOString(), alternateLink: "https://classroom.google.com/c/c1/m1" } };
          }),
        },
        announcements: {
          list: vi.fn(async (params: { courseId: string }) => ({ data: { announcements: params.courseId === "c1" ? [{ id: "a1", text: "Exam on Friday", materials: [], updateTime: new Date().toISOString(), alternateLink: "https://classroom.google.com/c/c1/a1" }] : [] } })),
          get: vi.fn(async (params: { id: string }) => {
            if (params.id !== "a1") throw new Error("Requested entity was not found.");
            return { data: { id: "a1", text: "Exam on Friday", materials: [], updateTime: new Date().toISOString(), creationTime: new Date().toISOString(), alternateLink: "https://classroom.google.com/c/c1/a1" } };
          }),
        },
      },
    },
    drive: {
      files: {
        get: vi.fn(async (params: { fileId: string; alt?: string }) => {
          if (params.alt === "media") return { data: Readable.from(["x"]) };
          return { data: { id: params.fileId, name: `${params.fileId}.bin`, mimeType: "application/pdf", size: "3" } };
        }),
        export: vi.fn(async () => ({ data: Buffer.from("x") })),
        create: vi.fn(async () => {
          if (overrides.uploadError) throw overrides.uploadError;
          return { data: { id: "u1", name: "essay.docx", webViewLink: "https://drive.google.com/file/u1", size: "9" } };
        }),
      },
    },
    auth: {},
  } as unknown as GoogleServices;
  return { services, modifyAttachments, turnIn };
}

async function connected(overrides: { denyWrites?: boolean; uploadError?: Error; attachError?: Error } = {}) {
  const { services, modifyAttachments, turnIn } = makeServices(overrides);
  const server = buildServer(async () => services);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, services, modifyAttachments, turnIn };
}

function textOf(result: unknown): string {
  const block = (result as { content?: Array<{ type: string; text?: string }> }).content?.[0];
  return block?.text ?? "";
}

function structuredOf(result: unknown): Record<string, unknown> {
  const data = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
  if (!data) throw new Error(`no structuredContent; text was: ${textOf(result)}`);
  return data;
}

async function expectFailure(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const result = await client.callTool({ name, arguments: args });
    if (!(result as { isError?: boolean }).isError) throw new Error(`expected ${name} to fail, got: ${textOf(result)}`);
    return textOf(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("expected ")) throw error;
    return message;
  }
}

describe("buildServer", () => {
  it("registers exactly the five tools in deterministic order", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_overview", "get_assignment", "search", "download_files", "submit_work"]);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(50);
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.outputSchema).toBeTruthy();
    }
  });

  it("get_overview view=courses returns ids and self-sufficient JSON text", async () => {
    const { client } = await connected();
    const result = await client.callTool({ name: "get_overview", arguments: { view: "courses" } });
    const data = structuredOf(result);
    const items = data.items as Array<{ id: string; name: string; state: string }>;
    expect(items.map((c) => c.id).sort()).toEqual(["c1", "c2", "c3"]);
    expect(items.find((c) => c.id === "c1")?.name).toBe("Physics 101");
    expect(JSON.parse(textOf(result))).toEqual(data);
  });

  it("get_overview view=due excludes turned-in work and keeps ids for chaining", async () => {
    const { client } = await connected();
    const result = await client.callTool({ name: "get_overview", arguments: { view: "due", window: 7 } });
    const data = structuredOf(result) as { items: Array<Record<string, unknown>>; total: number };
    const ids = data.items.map((item) => item.id);
    expect(ids).toContain("w1");
    expect(ids).not.toContain("w2");
    const row = data.items.find((item) => item.id === "w1") as Record<string, unknown>;
    expect(row.courseId).toBe("c1");
    expect(row.myState).toBe("CREATED");
    expect(typeof row.daysLeft).toBe("number");
    expect(row.link).toBeUndefined();
  });

  it("get_overview rejects out-of-range input with an actionable message", async () => {
    const { client } = await connected();
    const message = await expectFailure(client, "get_overview", { window: 31 });
    expect(message).toMatch(/30/);
  });

  it("get_assignment resolves fuzzy refs and exposes attachment Drive ids", async () => {
    const { client } = await connected();
    const result = await client.callTool({ name: "get_assignment", arguments: { course: "Physics 101", assignment: "waves" } });
    const data = structuredOf(result);
    expect(data.courseId).toBe("c1");
    expect(data.id).toBe("w1");
    expect((data.attachments as Array<{ id: string | null }>).some((a) => a.id === "t1")).toBe(true);
    expect((data.myAttachments as Array<{ id: string | null }>).some((a) => a.id === "d1")).toBe(true);
    expect(data.myState).toBe("CREATED");
  });

  it("get_assignment reports ambiguity with candidate names and ids", async () => {
    const { client } = await connected();
    const message = await expectFailure(client, "get_assignment", { course: "physics", assignment: "waves" });
    expect(message).toMatch(/Multiple courses match/);
    expect(message).toContain("Physics 101");
    expect(message).toContain("Physics 102");
    expect(message).toMatch(/courseId/);
  });

  it("search returns trimmed hits with snippets", async () => {
    const { client } = await connected();
    const result = await client.callTool({ name: "search", arguments: { query: "interference" } });
    const data = structuredOf(result) as { hits: Array<Record<string, unknown>> };
    expect(data.hits).toHaveLength(1);
    expect(data.hits[0].id).toBe("w1");
    expect(String(data.hits[0].snippet)).toContain("interference");
    expect(data.hits[0].link).toBeUndefined();
  });

  it("submit_work rejects turnIn without confirmation before any mutation", async () => {
    const { client, modifyAttachments, turnIn } = await connected();
    const message = await expectFailure(client, "submit_work", { courseId: "c1", assignmentId: "w1", turnIn: true });
    expect(message).toMatch(/confirmTurnIn/);
    expect(modifyAttachments).not.toHaveBeenCalled();
    expect(turnIn).not.toHaveBeenCalled();
  });

  it("submit_work reports blocked with UI links when Google denies writes", async () => {
    const { client, modifyAttachments } = await connected();
    const result = await client.callTool({ name: "submit_work", arguments: { courseId: "c1", assignmentId: "w1", fileIds: ["d9"] } });
    const data = structuredOf(result);
    expect(modifyAttachments).toHaveBeenCalledTimes(1);
    expect(data.blocked).toBe(true);
    expect(data.attached).toBe(false);
    expect(data.turnedIn).toBe(false);
    expect(data.assignmentLink).toBe("https://classroom.google.com/c/c1/w1");
    expect(String(data.message)).toContain("Finish in Classroom");
    expect(String(data.message)).not.toContain("Attached 1");
  });

  it("submit_work attaches and turns in when writes are allowed", async () => {
    const { client, modifyAttachments, turnIn } = await connected({ denyWrites: false });
    const result = await client.callTool({
      name: "submit_work",
      arguments: { courseId: "c1", assignmentId: "w1", fileIds: ["d9"], turnIn: true, confirmTurnIn: "I confirm turn in" },
    });
    const data = structuredOf(result);
    expect(modifyAttachments).toHaveBeenCalledTimes(1);
    expect(turnIn).toHaveBeenCalledTimes(1);
    expect(data).toMatchObject({
      attachmentAttempted: true, attached: true, attachedCount: 1, turnInAttempted: true, turnedIn: true,
      blocked: false, turnInSkippedReason: null, uploadsRequested: 0, uploadsSucceeded: 0, uploadsFailed: 0, warnings: [],
    });
    expect(String(data.message)).toContain("Attached 1 item(s)");
    expect(String(data.message)).toContain("Turned in");
  });

  it("submit_work does not turn in when a requested upload fails", async () => {
    const dest = await tempDownloadDir();
    try {
      const file = path.join(dest, "essay.docx");
      await fs.writeFile(file, "content");
      const { client, modifyAttachments, turnIn } = await connected({ denyWrites: false, uploadError: new Error("network down") });
      const result = await client.callTool({
        name: "submit_work",
        arguments: { courseId: "c1", assignmentId: "w1", files: [{ path: file }], turnIn: true, confirmTurnIn: "I confirm turn in" },
      });
      const data = structuredOf(result);
      expect(modifyAttachments).not.toHaveBeenCalled();
      expect(turnIn).not.toHaveBeenCalled();
      expect(data).toMatchObject({ uploadsRequested: 1, uploadsSucceeded: 0, uploadsFailed: 1, attached: false, turnedIn: false });
      expect(String(data.turnInSkippedReason)).toMatch(/upload failed/);
      expect(String(data.message)).toMatch(/Upload failed for essay\.docx/);
      expect(String(data.message)).not.toMatch(/Attached \d/);
      expect(String(data.message)).toMatch(/Every upload failed|every upload failed|Nothing was attached/);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it("submit_work skips turn-in when attachment fails for a non-permission reason", async () => {
    const attachError = Object.assign(new Error("bad request"), { code: 400 });
    const { client, turnIn } = await connected({ denyWrites: false, attachError });
    const result = await client.callTool({
      name: "submit_work",
      arguments: { courseId: "c1", assignmentId: "w1", fileIds: ["d9"], turnIn: true, confirmTurnIn: "I confirm turn in" },
    });
    const data = structuredOf(result);
    expect(turnIn).not.toHaveBeenCalled();
    expect(data).toMatchObject({ attachmentAttempted: true, attached: false, turnInAttempted: false, turnedIn: false });
    expect(String(data.turnInSkippedReason)).toMatch(/attachment step failed/);
    expect((data.warnings as string[]).join(" ")).toMatch(/Attach failed: bad request/);
  });

  it("submit_work never retries the non-idempotent attachment write", async () => {
    const serverError = Object.assign(new Error("server error"), { code: 500 });
    const { client, modifyAttachments } = await connected({ denyWrites: false, attachError: serverError });
    await client.callTool({ name: "submit_work", arguments: { courseId: "c1", assignmentId: "w1", fileIds: ["d9"] } });
    expect(modifyAttachments).toHaveBeenCalledTimes(1);
  });

  it("caches the course index briefly across calls", async () => {
    const { client, services } = await connected();
    await client.callTool({ name: "get_overview", arguments: { view: "due" } });
    const first = (services.classroom.courses.list as ReturnType<typeof vi.fn>).mock.calls.length;
    await client.callTool({ name: "get_overview", arguments: { view: "missing" } });
    const second = (services.classroom.courses.list as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(second).toBe(first);
  });

  it("submit_work allows a turn-in-only call with confirmation", async () => {
    const { client, modifyAttachments, turnIn } = await connected({ denyWrites: false });
    const result = await client.callTool({
      name: "submit_work",
      arguments: { courseId: "c1", assignmentId: "w1", turnIn: true, confirmTurnIn: "I confirm turn in" },
    });
    const data = structuredOf(result);
    expect(modifyAttachments).not.toHaveBeenCalled();
    expect(turnIn).toHaveBeenCalledTimes(1);
    expect(data).toMatchObject({ attachmentAttempted: false, attached: false, turnInAttempted: true, turnedIn: true });
    expect(String(data.message)).toContain("Turned in");
  });

  it("submit_work with a partial upload failure never claims attachment success", async () => {
    const dest = await tempDownloadDir();
    try {
      const good = path.join(dest, "good.docx");
      await fs.writeFile(good, "content");
      const { client, modifyAttachments, turnIn } = await connected({
        denyWrites: false,
        uploadError: undefined,
      });
      // One real file plus one missing file: the missing one fails the upload step.
      const result = await client.callTool({
        name: "submit_work",
        arguments: {
          courseId: "c1", assignmentId: "w1",
          files: [{ path: good }, { path: path.join(dest, "missing.docx") }],
          turnIn: true, confirmTurnIn: "I confirm turn in",
        },
      });
      const data = structuredOf(result);
      expect(data).toMatchObject({ uploadsRequested: 2, uploadsSucceeded: 1, uploadsFailed: 1 });
      expect(modifyAttachments).not.toHaveBeenCalled();
      expect(turnIn).not.toHaveBeenCalled();
      expect(String(data.message)).toMatch(/Nothing was attached|nothing was attached/);
      expect((data.uploaded as Array<{ id: string | null }>).some((u) => u.id === "u1")).toBe(true);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it("download_files rejects destinations outside the allowed roots", async () => {
    const { client } = await connected();
    const message = await expectFailure(client, "download_files", { fileIds: ["d1"], destinationDir: "/etc" });
    expect(message).toMatch(/must stay inside/);
    expect(message).toMatch(/CLASSMCP_WORKDIR/);
  });

  it("get_overview surfaces skippedArchived and includeArchived scans archived courses", async () => {
    const { client } = await connected();
    const activeOnly = structuredOf(await client.callTool({ name: "get_overview", arguments: { view: "due", window: 7 } }));
    expect(activeOnly.skippedArchived).toBe(1);
    expect((activeOnly.items as Array<{ id: string }>).map((item) => item.id)).not.toContain("w4");

    const withArchived = structuredOf(await client.callTool({ name: "get_overview", arguments: { view: "due", window: 7, includeArchived: true } }));
    expect(withArchived.skippedArchived).toBe(0);
    expect((withArchived.items as Array<{ id: string }>).map((item) => item.id)).toContain("w4");
  });

  it("search hits carry attachment Drive ids so materials are downloadable", async () => {
    const { client } = await connected();
    const data = structuredOf(await client.callTool({ name: "search", arguments: { query: "slides" } })) as { hits: Array<Record<string, unknown>> };
    expect(data.hits).toHaveLength(1);
    const hit = data.hits[0];
    expect(hit.kind).toBe("material");
    expect(hit.id).toBe("m1");
    expect((hit.attachments as Array<{ id: string | null }>)[0].id).toBe("t9");
  });

  it("material resource reads any material a search can return", async () => {
    const { client } = await connected();
    const result = await client.readResource({ uri: "classroom://courses/c1/materials/m1" });
    const body = JSON.parse((result.contents[0] as { text: string }).text);
    expect(body).toMatchObject({ kind: "material", courseId: "c1", id: "m1", descriptionStatus: "full" });
    expect(body.description).toContain("Chapter 1 slides");
    expect(body.attachments[0]).toMatchObject({ kind: "driveFile", id: "t9" });
  });

  it("announcement resource reads any announcement a search can return", async () => {
    const { client } = await connected();
    const result = await client.readResource({ uri: "classroom://courses/c1/announcements/a1" });
    const body = JSON.parse((result.contents[0] as { text: string }).text);
    expect(body).toMatchObject({ kind: "announcement", courseId: "c1", id: "a1", text: "Exam on Friday", textStatus: "full" });
  });

  it("course resource lists materials and announcements, not just open work", async () => {
    const { client } = await connected();
    const result = await client.readResource({ uri: "classroom://courses/c1" });
    const body = JSON.parse((result.contents[0] as { text: string }).text);
    expect(body.totals).toMatchObject({ materials: 1, announcements: 1 });
    expect(body.materials[0]).toMatchObject({ id: "m1" });
    expect(body.materials[0].attachments[0].id).toBe("t9");
    expect(body.announcements[0]).toMatchObject({ id: "a1" });
    expect(body.topicsStatus).toBe("present");
    expect(body.openWork.length + body.missing.length).toBeGreaterThan(0);
  });

  it("get_assignment emits reason codes instead of bare nulls", async () => {
    const { client } = await connected();
    const data = structuredOf(await client.callTool({ name: "get_assignment", arguments: { courseId: "c1", assignmentId: "w1" } }));
    expect(data.promptStatus).toBe("full");
    expect(data.rubricStatus).toBe("none");
    expect(data.topicStatus).toBe("none");
    expect(data.historyStatus).toBe("present");
    expect((data.history as Array<{ state: string }>)[0].state).toBe("CREATED");
  });

  async function tempDownloadDir(): Promise<string> {
    const dir = path.join(os.homedir(), "Downloads", `classmcp-test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  function fetchedIds(services: GoogleServices): string[] {
    const get = services.drive.files.get as unknown as { mock: { calls: Array<[Record<string, unknown>]> } };
    return get.mock.calls.map((call) => String((call[0] as { fileId: string }).fileId));
  }

  it("download_files with courseId + fileIds and no assignment downloads exactly those files", async () => {
    const { client, services } = await connected();
    const dest = await tempDownloadDir();
    try {
      const result = await client.callTool({ name: "download_files", arguments: { courseId: "c1", fileIds: ["f1", "f2"], destinationDir: dest } });
      const data = structuredOf(result) as { saved: Array<{ path: string | null; error: string | null }>; savedCount: number; failedCount: number };
      expect(data.savedCount).toBe(2);
      expect(data.failedCount).toBe(0);
      expect(data.saved).toHaveLength(2);
      for (const entry of data.saved) {
        expect(entry.error).toBeNull();
        expect(entry.path?.startsWith(dest)).toBe(true);
      }
      const fetched = fetchedIds(services);
      expect(fetched).toContain("f1");
      expect(fetched).toContain("f2");
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it("download_files resolves materialId and downloads its attachments", async () => {
    const { client } = await connected();
    const dest = await tempDownloadDir();
    try {
      const result = await client.callTool({ name: "download_files", arguments: { courseId: "c1", materialId: "m1", destinationDir: dest } });
      const data = structuredOf(result) as { saved: Array<{ name: string; error: string | null }>; savedCount: number; failedCount: number };
      expect(data.savedCount).toBe(1);
      expect(data.failedCount).toBe(0);
      expect(data.saved[0].name).toBe("slides.pdf");
      expect(data.saved[0].error).toBeNull();
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it("download_files falls back to materials when a material id or title is passed as assignment", async () => {
    const { client } = await connected();
    const destA = await tempDownloadDir();
    const destB = await tempDownloadDir();
    try {
      const byId = structuredOf(await client.callTool({ name: "download_files", arguments: { courseId: "c1", assignmentId: "m1", destinationDir: destA } })) as { savedCount: number; saved: Array<{ name: string }> };
      expect(byId.savedCount).toBe(1);
      expect(byId.saved[0].name).toBe("slides.pdf");
      const byTitle = structuredOf(await client.callTool({ name: "download_files", arguments: { courseId: "c1", assignment: "Slides", destinationDir: destB } })) as { savedCount: number; saved: Array<{ name: string }> };
      expect(byTitle.savedCount).toBe(1);
      expect(byTitle.saved[0].name).toBe("slides.pdf");
    } finally {
      await fs.rm(destA, { recursive: true, force: true });
      await fs.rm(destB, { recursive: true, force: true });
    }
  });

  it("download_files treats fileIds as an exclusive filter over the scoped item", async () => {
    const { client, services } = await connected();
    const dest = await tempDownloadDir();
    try {
      // w1 carries t1 (teacher) + d1 (mine); requesting only t1 must not fetch d1.
      const result = await client.callTool({ name: "download_files", arguments: { courseId: "c1", assignmentId: "w1", fileIds: ["t1"], destinationDir: dest } });
      const data = structuredOf(result) as { saved: Array<{ name: string; error: string | null }>; savedCount: number; failedCount: number };
      expect(data.saved).toHaveLength(1);
      expect(data.savedCount).toBe(1);
      expect(data.failedCount).toBe(0);
      expect(data.saved[0].name).toBe("handout.pdf");
      const fetched = fetchedIds(services);
      expect(fetched).toContain("t1");
      expect(fetched).not.toContain("d1");
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it("download_files without fileIds downloads every attachment of the scoped assignment", async () => {
    const { client } = await connected();
    const dest = await tempDownloadDir();
    try {
      const result = await client.callTool({ name: "download_files", arguments: { courseId: "c1", assignmentId: "w1", destinationDir: dest } });
      const data = structuredOf(result) as { saved: Array<{ name: string; error: string | null }>; savedCount: number; failedCount: number };
      expect(data.savedCount).toBe(2);
      expect(data.failedCount).toBe(0);
      expect(data.saved.map((s) => s.name).sort()).toEqual(["handout.pdf", "notes.pdf"]);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it("download_files rejects more than one item kind", async () => {
    const { client } = await connected();
    const message = await expectFailure(client, "download_files", { courseId: "c1", assignmentId: "w1", materialId: "m1", fileIds: ["t1"] });
    expect(message).toMatch(/only one of assignment, material, or announcement/);
  });
});
