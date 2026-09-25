import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GoogleServices } from "./google.js";
import { buildServer } from "./server.js";

function datePlus(days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.now() + days * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const PROJECT_DENIED = new Error("@ProjectPermissionDenied The Developer Console project is not permitted to make this request.");

function makeServices(overrides: { denyWrites?: boolean } = {}) {
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
    c3: [],
  };
  const subs: Record<string, unknown[]> = {
    c1: [
      { courseWorkId: "w1", state: "CREATED", late: false, assignmentSubmission: { attachments: [{ driveFile: { id: "d1", title: "notes.pdf" } }] } },
      { courseWorkId: "w2", state: "TURNED_IN", late: false },
    ],
    c2: [], c3: [],
  };
  const modifyAttachments = vi.fn(async () => {
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
            modifyAttachments,
            turnIn,
          },
        },
        topics: { get: vi.fn(async () => ({ data: { name: "Unit 1" } })) },
        courseWorkMaterials: { list: vi.fn(async (params: { courseId: string }) => ({ data: { courseWorkMaterial: params.courseId === "c1" ? [{ id: "m1", title: "Slides", updateTime: new Date().toISOString() }] : [] } })) },
        announcements: { list: vi.fn(async () => ({ data: { announcements: [] } })) },
      },
    },
    drive: {
      files: {
        get: vi.fn(async (params: { fileId: string; alt?: string }) => {
          if (params.alt === "media") return { data: Buffer.from("x") };
          return { data: { id: params.fileId, name: "handout.pdf", mimeType: "application/pdf", size: "3" } };
        }),
        export: vi.fn(async () => ({ data: Buffer.from("x") })),
        create: vi.fn(async () => ({ data: { id: "u1", name: "essay.docx", webViewLink: "https://drive.google.com/file/u1", size: "9" } })),
      },
    },
    auth: {},
  } as unknown as GoogleServices;
  return { services, modifyAttachments, turnIn };
}

async function connected(overrides: { denyWrites?: boolean } = {}) {
  const { services, modifyAttachments, turnIn } = makeServices(overrides);
  const server = buildServer(async () => services);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, modifyAttachments, turnIn };
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
  });

  it("download_files rejects destinations outside the allowed roots", async () => {
    const { client } = await connected();
    const message = await expectFailure(client, "download_files", { fileIds: ["d1"], destinationDir: "/etc" });
    expect(message).toMatch(/must stay inside/);
    expect(message).toMatch(/CLASSMCP_WORKDIR/);
  });
});
