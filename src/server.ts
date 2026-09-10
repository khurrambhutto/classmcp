import fs from "node:fs/promises";
import path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServices, downloadFile, withRetry } from "./google.js";
import { getAssignmentStatus, getWhatsDue, getWhatsNew, listActiveCourses } from "./digest.js";

type Services = Awaited<ReturnType<typeof createServices>>;

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/[.]+$/, "");
  const hint = /auth|token|unauthorized|invalid_grant/i.test(message) ? " Run `classmcp setup` to reconnect Google." : "";
  return { content: [{ type: "text" as const, text: `Request failed: ${message}.${hint}` }], isError: true as const };
}

function friendly(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  return new Error(`Request failed: ${raw.replace(/[.]+$/, "")}.`);
}

// --- Output shapes (every tool returns text + typed structuredContent) ---

const CourseSchema = z.object({
  id: z.string(),
  name: z.string(),
  section: z.string().optional(),
  room: z.string().optional(),
  courseState: z.string().optional(),
  alternateLink: z.string().optional(),
});

const CourseWorkSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  state: z.string().optional(),
  workType: z.string().optional(),
  maxPoints: z.number().optional(),
  alternateLink: z.string().optional(),
  creationTime: z.string().optional(),
  updateTime: z.string().optional(),
  dueDate: z.object({
    year: z.number().optional(),
    month: z.number().optional(),
    day: z.number().optional(),
  }).passthrough().optional(),
  dueTime: z.object({
    hours: z.number().optional(),
    minutes: z.number().optional(),
  }).passthrough().optional(),
});

const MaterialSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  alternateLink: z.string().optional(),
  creationTime: z.string().optional(),
  updateTime: z.string().optional(),
});

const AnnouncementSchema = z.object({
  id: z.string().optional(),
  text: z.string().optional(),
  alternateLink: z.string().optional(),
  creationTime: z.string().optional(),
  updateTime: z.string().optional(),
});

const SubmissionSchema = z.object({
  id: z.string().optional(),
  courseId: z.string().optional(),
  courseWorkId: z.string().optional(),
  userId: z.string().optional(),
  state: z.string().optional(),
  late: z.boolean().optional(),
  assignedGrade: z.number().optional(),
  alternateLink: z.string().optional(),
});

const DueItemSchema = z.object({
  course: z.string(),
  courseId: z.string(),
  id: z.string(),
  title: z.string(),
  due: z.string(),
  daysLeft: z.number(),
  myState: z.string(),
  late: z.boolean(),
  points: z.number().nullable(),
});

const StatusItemSchema = z.object({
  courseId: z.string(),
  id: z.string(),
  title: z.string(),
  state: z.string().nullable(),
  workType: z.string().nullable(),
  due: z.string().nullable(),
  points: z.number().nullable(),
  myState: z.string(),
  late: z.boolean(),
  grade: z.number().nullable(),
  materials: z.array(z.string()),
  description: z.string(),
  link: z.string().nullable(),
});

const NewsItemSchema = z.object({
  type: z.enum(["assignment", "material", "announcement"]),
  course: z.string(),
  courseId: z.string(),
  id: z.string(),
  title: z.string(),
  updated: z.string().nullable(),
});

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const;

export function buildServer(getServices: () => Promise<Services>): McpServer {
  const server = new McpServer({ name: "classmcp", version: "0.1.0" });

  server.registerTool("list_courses", {
    title: "List courses",
    description: "List Google Classroom courses for the signed-in student (ACTIVE + ARCHIVED), one page at a time. pageSize 1-100 (default 30). Pass cursor from the previous response for the next page; a missing nextCursor means done. Start here to get courseIds.",
    inputSchema: { cursor: z.string().optional(), pageSize: z.number().min(1).max(100).optional() },
    outputSchema: { courses: z.array(CourseSchema), nextCursor: z.string().nullable() },
    annotations: READ_ONLY,
  }, async ({ cursor, pageSize }) => {
    try {
      const services = await getServices();
      const response = await withRetry("courses.list", () => services.classroom.courses.list({
        studentId: "me", courseStates: ["ACTIVE", "ARCHIVED"],
        pageSize: pageSize ?? 30, pageToken: cursor,
      }));
      const courses = (response.data.courses ?? []).filter((c) => c.id).map((c) => ({
        id: c.id as string,
        name: c.name ?? "Unnamed",
        section: c.section ?? undefined,
        room: c.room ?? undefined,
        courseState: c.courseState ?? undefined,
        alternateLink: c.alternateLink ?? undefined,
      }));
      const nextCursor = response.data.nextPageToken ?? null;
      const lines = courses.map((c) => `- ${c.name} (${c.id})`).join("\n");
      return {
        content: [{ type: "text", text: `Found ${courses.length} course(s):\n${lines}${nextCursor ? `\nMore pages available, pass cursor for the next page.` : ""}` }],
        structuredContent: { courses, nextCursor },
      };
    } catch (error) { return fail(error); }
  });

  server.registerTool("list_assignments", {
    title: "List assignments",
    description: "List published and draft coursework in one course. Needs courseId from list_courses. For due-soon items across ALL courses prefer whats_due.",
    inputSchema: { courseId: z.string() },
    outputSchema: { assignments: z.array(CourseWorkSchema) },
    annotations: READ_ONLY,
  }, async ({ courseId }) => {
    try {
      const services = await getServices();
      const response = await withRetry(`courseWork.list ${courseId}`, () => services.classroom.courses.courseWork.list({
        courseId, courseWorkStates: ["PUBLISHED", "DRAFT"], orderBy: "updateTime desc",
      }));
      const assignments = response.data.courseWork ?? [];
      const lines = assignments.map((w) => `- ${w.title ?? "Untitled"} (${w.id})`).join("\n");
      return {
        content: [{ type: "text", text: `Found ${assignments.length} assignment(s):\n${lines}` }],
        structuredContent: { assignments },
      };
    } catch (error) { return fail(error); }
  });

  server.registerTool("get_assignment", {
    title: "Get assignment",
    description: "Get one assignment's full details by course and assignment ID. For a compact status with your turn-in state, grade, and trimmed description prefer assignment_status.",
    inputSchema: { courseId: z.string(), assignmentId: z.string() },
    outputSchema: { assignment: CourseWorkSchema },
    annotations: READ_ONLY,
  }, async ({ courseId, assignmentId }) => {
    try {
      const services = await getServices();
      const response = await withRetry(`courseWork.get ${assignmentId}`, () => services.classroom.courses.courseWork.get({ courseId, id: assignmentId }));
      const assignment = response.data;
      return {
        content: [{ type: "text", text: `${assignment.title ?? "Untitled"} (state ${assignment.state ?? "unknown"})` }],
        structuredContent: { assignment },
      };
    } catch (error) { return fail(error); }
  });

  server.registerTool("list_materials", {
    title: "List materials",
    description: "List course materials and announcements for one course. Needs courseId from list_courses.",
    inputSchema: { courseId: z.string() },
    outputSchema: { materials: z.array(MaterialSchema), announcements: z.array(AnnouncementSchema) },
    annotations: READ_ONLY,
  }, async ({ courseId }) => {
    try {
      const services = await getServices();
      const [materials, announcements] = await Promise.all([
        withRetry(`materials.list ${courseId}`, () => services.classroom.courses.courseWorkMaterials.list({ courseId })),
        withRetry(`announcements.list ${courseId}`, () => services.classroom.courses.announcements.list({ courseId })),
      ]);
      const data = {
        materials: materials.data.courseWorkMaterial ?? [],
        announcements: announcements.data.announcements ?? [],
      };
      return {
        content: [{ type: "text", text: `Found ${data.materials.length} material(s) and ${data.announcements.length} announcement(s).` }],
        structuredContent: data,
      };
    } catch (error) { return fail(error); }
  });

  server.registerTool("download_material", {
    title: "Download material",
    description: "Download an accessible Drive file to an absolute local path. destination must be absolute; parent directories are created. Returns the saved path.",
    inputSchema: { fileId: z.string(), destination: z.string() },
    outputSchema: { path: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ fileId, destination }) => {
    try {
      const services = await getServices();
      const resolved = path.resolve(destination);
      if (!path.isAbsolute(destination) || destination.includes("\0")) throw new Error("destination must be an absolute local path without null bytes.");
      const saved = await downloadFile(services.drive, fileId, resolved);
      return {
        content: [{ type: "text", text: `Saved to ${saved}.` }],
        structuredContent: { path: saved },
      };
    } catch (error) { return fail(error); }
  });

  server.registerTool("upload_local_file", {
    title: "Upload file",
    description: "Upload a local file (max 100 MB) to the student's Drive for submission. Returns the Drive file id — pass it to attach_file_to_submission.",
    inputSchema: { filePath: z.string(), name: z.string().optional() },
    outputSchema: { id: z.string(), name: z.string().optional(), webViewLink: z.string().optional() },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ filePath, name }) => {
    try {
      const services = await getServices();
      const absolute = path.resolve(filePath); const stat = await fs.stat(absolute);
      if (!stat.isFile()) throw new Error("filePath must point to a file.");
      if (stat.size > 100 * 1024 * 1024) throw new Error("filePath must be 100 MB or smaller.");
      const response = await withRetry("drive.files.create", async () => services.drive.files.create({
        requestBody: { name: name ?? path.basename(absolute) },
        media: { body: (await import("node:fs")).createReadStream(absolute) },
        fields: "id,name,webViewLink",
      }));
      if (!response.data.id) throw new Error("Drive upload did not return a file id.");
      const data = { id: response.data.id, name: response.data.name ?? undefined, webViewLink: response.data.webViewLink ?? undefined };
      return {
        content: [{ type: "text", text: `Uploaded ${data.name ?? data.id} (id ${data.id}).` }],
        structuredContent: data,
      };
    } catch (error) { return fail(error); }
  });

  server.registerTool("attach_file_to_submission", {
    title: "Attach file",
    description: "Attach a Drive file to the student's Classroom submission. This does NOT turn it in — call turn_in_submission afterwards.",
    inputSchema: { courseId: z.string(), assignmentId: z.string(), fileId: z.string() },
    outputSchema: { submission: SubmissionSchema },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ courseId, assignmentId, fileId }) => {
    try {
      const services = await getServices();
      const response = await withRetry(`submissions.attach ${assignmentId}`, () => services.classroom.courses.courseWork.studentSubmissions.modifyAttachments({
        courseId, courseWorkId: assignmentId, id: "me",
        requestBody: { addAttachments: [{ driveFile: { id: fileId } }] },
      }));
      const submission = response.data;
      return {
        content: [{ type: "text", text: `Attached to submission (state ${submission.state ?? "unknown"}). Not turned in yet.` }],
        structuredContent: { submission },
      };
    } catch (error) { return fail(error); }
  });

  server.registerTool("turn_in_submission", {
    title: "Turn in submission",
    description: "Turn in a submission. Destructive and final — only call after the student explicitly confirms this exact action. confirmation must be exactly: I confirm turn in",
    inputSchema: { courseId: z.string(), assignmentId: z.string(), confirmation: z.literal("I confirm turn in") },
    outputSchema: { turnedIn: z.boolean(), assignmentId: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ courseId, assignmentId, confirmation }) => {
    try {
      const services = await getServices();
      if (confirmation !== "I confirm turn in") throw new Error("Explicit confirmation is required: I confirm turn in");
      await withRetry(`submissions.turnIn ${assignmentId}`, () => services.classroom.courses.courseWork.studentSubmissions.turnIn({
        courseId, courseWorkId: assignmentId, id: "me", requestBody: {},
      }));
      return {
        content: [{ type: "text", text: "Assignment turned in." }],
        structuredContent: { turnedIn: true, assignmentId },
      };
    } catch (error) { return fail(error); }
  });

  server.registerTool("whats_due", {
    title: "What's due",
    description: "What is due soon across all ACTIVE courses, with your turn-in state included. Answers 'do I have anything due' in one call — prefer over looping list_assignments. daysAhead 1-90 (default 14); limit 1-100 (default 50).",
    inputSchema: {
      daysAhead: z.number().min(1).max(90).optional(),
      limit: z.number().min(1).max(100).optional(),
      includeNoDueDate: z.boolean().optional(),
      includeTurnedIn: z.boolean().optional(),
    },
    outputSchema: { checkedCourses: z.number(), openCount: z.number(), items: z.array(DueItemSchema) },
    annotations: READ_ONLY,
  }, async (opts) => {
    try {
      const services = await getServices();
      const data = await getWhatsDue(services, opts);
      return {
        content: [{ type: "text", text: `${data.openCount} open assignment(s) across ${data.checkedCourses} course(s).` }],
        structuredContent: data,
      };
    } catch (error) { return fail(error); }
  });

  server.registerTool("assignment_status", {
    title: "Assignment status",
    description: "Compact status of one assignment: turn-in state, grade, due date, materials, trimmed description. maxDescChars 0-2000 (default 300). Prefer over get_assignment.",
    inputSchema: {
      courseId: z.string(), assignmentId: z.string(), maxDescChars: z.number().min(0).max(2000).optional(),
    },
    outputSchema: { status: StatusItemSchema },
    annotations: READ_ONLY,
  }, async ({ courseId, assignmentId, maxDescChars }) => {
    try {
      const services = await getServices();
      const status = await getAssignmentStatus(services, courseId, assignmentId, maxDescChars ?? 300);
      return {
        content: [{ type: "text", text: `${status.title}: ${status.myState}${status.late ? " (late)" : ""}${status.grade != null ? `, grade ${status.grade}` : ""}.` }],
        structuredContent: { status },
      };
    } catch (error) { return fail(error); }
  });

  server.registerTool("whats_new", {
    title: "What's new",
    description: "What is new (assignments, materials, announcements) across all ACTIVE courses since N days ago. Answers 'whats new on my classroom today' in one call. sinceDays 0-30 (default 1); limit 1-100 (default 30).",
    inputSchema: {
      sinceDays: z.number().min(0).max(30).optional(), limit: z.number().min(1).max(100).optional(),
    },
    outputSchema: { since: z.string(), count: z.number(), items: z.array(NewsItemSchema) },
    annotations: READ_ONLY,
  }, async (opts) => {
    try {
      const services = await getServices();
      const data = await getWhatsNew(services, opts);
      return {
        content: [{ type: "text", text: `${data.count} new item(s) since ${data.since}.` }],
        structuredContent: data,
      };
    } catch (error) { return fail(error); }
  });

  // --- Resources: stable addresses for course data + name autocomplete ---

  server.resource("course", new ResourceTemplate("classroom://courses/{courseId}", {
    list: async () => {
      const services = await getServices();
      const courses = await listActiveCourses(services);
      return {
        resources: courses.map((c) => ({
          uri: `classroom://courses/${c.id}`,
          name: c.name,
          mimeType: "application/json",
        })),
      };
    },
    complete: {
      courseId: async (value) => {
        const services = await getServices();
        const courses = await listActiveCourses(services);
        const q = value.trim().toLowerCase();
        if (!q) return courses.map((c) => c.id).slice(0, 100);
        return courses
          .filter((c) => c.name.toLowerCase().includes(q) || c.id.includes(value.trim()))
          .map((c) => c.id)
          .slice(0, 100);
      },
    },
  }), {
    title: "Course overview",
    description: "JSON overview of one Classroom course with recent coursework. {courseId} autocompletes from enrolled course names.",
    mimeType: "application/json",
  }, async (uri, variables) => {
    try {
      const courseId = String(variables.courseId ?? "");
      if (!courseId) throw new Error("courseId is required.");
      const services = await getServices();
      const [course, work] = await Promise.all([
        withRetry(`courses.get ${courseId}`, () => services.classroom.courses.get({ id: courseId })),
        withRetry(`courseWork.list ${courseId}`, () => services.classroom.courses.courseWork.list({
          courseId, courseWorkStates: ["PUBLISHED"], orderBy: "updateTime desc", pageSize: 20,
        })),
      ]);
      const body = {
        id: courseId,
        name: course.data.name ?? null,
        section: course.data.section ?? null,
        courseState: course.data.courseState ?? null,
        alternateLink: course.data.alternateLink ?? null,
        recentWork: (work.data.courseWork ?? []).map((w) => ({
          id: w.id ?? null,
          title: w.title ?? "Untitled",
          state: w.state ?? null,
          alternateLink: w.alternateLink ?? null,
        })),
      };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
    } catch (error) { throw friendly(error); }
  });

  server.resource("assignment", new ResourceTemplate("classroom://courses/{courseId}/assignments/{assignmentId}", {
    list: undefined,
    complete: {
      assignmentId: async (value, context) => {
        const courseId = context?.arguments?.courseId;
        if (!courseId) return [];
        const services = await getServices();
        const response = await withRetry(`courseWork.list ${courseId}`, () => services.classroom.courses.courseWork.list({
          courseId, courseWorkStates: ["PUBLISHED"], orderBy: "updateTime desc", pageSize: 100,
        }));
        const q = value.trim().toLowerCase();
        return (response.data.courseWork ?? [])
          .filter((w) => !q || (w.title ?? "").toLowerCase().includes(q))
          .map((w) => w.id ?? "")
          .filter(Boolean)
          .slice(0, 100);
      },
    },
  }), {
    title: "Assignment detail",
    description: "Compact JSON status of one assignment: turn-in state, grade, due date, materials. {assignmentId} autocompletes from assignment titles once courseId is known.",
    mimeType: "application/json",
  }, async (uri, variables) => {
    try {
      const courseId = String(variables.courseId ?? "");
      const assignmentId = String(variables.assignmentId ?? "");
      if (!courseId || !assignmentId) throw new Error("courseId and assignmentId are required.");
      const services = await getServices();
      const status = await getAssignmentStatus(services, courseId, assignmentId, 1000);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(status, null, 2) }] };
    } catch (error) { throw friendly(error); }
  });

  return server;
}

export async function runServer(): Promise<void> {
  let cached: Promise<Services> | undefined;
  const getServices = () => (cached ??= createServices());
  const server = buildServer(getServices);
  await server.connect(new StdioServerTransport());
}
