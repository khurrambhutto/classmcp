import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServices, downloadFile } from "./google.js";
import { getAssignmentStatus, getWhatsDue, getWhatsNew } from "./digest.js";

type Services = Awaited<ReturnType<typeof createServices>>;

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const hint = /auth|token|unauthorized|invalid_grant/i.test(message) ? " Run `classmcp setup` to reconnect Google." : "";
  return { content: [{ type: "text" as const, text: `Request failed: ${message}.${hint}` }], isError: true as const };
}

export function buildServer(getServices: () => Promise<Services>): McpServer {
  const server = new McpServer({ name: "classmcp", version: "0.1.0" });
  server.tool("list_courses", "List all Google Classroom courses for the signed-in student (ACTIVE + ARCHIVED). Takes no parameters. Start here to get courseIds for the other tools.", {}, async () => {
    try {
      const services = await getServices();
      const courses: object[] = []; let pageToken: string | undefined;
      do { const response = await services.classroom.courses.list({ studentId: "me", courseStates: ["ACTIVE", "ARCHIVED"], pageToken }); courses.push(...(response.data.courses ?? [])); pageToken = response.data.nextPageToken ?? undefined; } while (pageToken);
      return ok(JSON.stringify(courses, null, 2));
    } catch (error) { return fail(error); }
  });
  server.tool("list_assignments", "List published and draft coursework in one course. Needs courseId from list_courses. For due-soon items across ALL courses prefer whats_due.", { courseId: z.string() }, async ({ courseId }) => {
    try {
      const services = await getServices();
      const response = await services.classroom.courses.courseWork.list({ courseId, courseWorkStates: ["PUBLISHED", "DRAFT"], orderBy: "updateTime desc" });
      return ok(JSON.stringify(response.data.courseWork ?? [], null, 2));
    } catch (error) { return fail(error); }
  });
  server.tool("get_assignment", "Get one assignment's full details by course and assignment ID. For a compact status with your turn-in state, grade, and trimmed description prefer assignment_status.", { courseId: z.string(), assignmentId: z.string() }, async ({ courseId, assignmentId }) => {
    try {
      const services = await getServices();
      const response = await services.classroom.courses.courseWork.get({ courseId, id: assignmentId });
      return ok(JSON.stringify(response.data, null, 2));
    } catch (error) { return fail(error); }
  });
  server.tool("list_materials", "List course materials and announcements for one course. Needs courseId from list_courses.", { courseId: z.string() }, async ({ courseId }) => {
    try {
      const services = await getServices();
      const [materials, announcements] = await Promise.all([services.classroom.courses.courseWorkMaterials.list({ courseId }), services.classroom.courses.announcements.list({ courseId })]);
      return ok(JSON.stringify({ materials: materials.data.courseWorkMaterial ?? [], announcements: announcements.data.announcements ?? [] }, null, 2));
    } catch (error) { return fail(error); }
  });
  server.tool("download_material", "Download an accessible Drive file to an absolute local path. destination must be absolute; parent directories are created. Returns the saved path.", { fileId: z.string(), destination: z.string() }, async ({ fileId, destination }) => {
    try {
      const services = await getServices();
      const resolved = path.resolve(destination);
      if (!path.isAbsolute(destination) || destination.includes("\0")) throw new Error("destination must be an absolute local path without null bytes.");
      return ok(await downloadFile(services.drive, fileId, resolved));
    } catch (error) { return fail(error); }
  });
  server.tool("upload_local_file", "Upload a local file (max 100 MB) to the student's Drive for submission. Returns the Drive file id — pass it to attach_file_to_submission.", { filePath: z.string(), name: z.string().optional() }, async ({ filePath, name }) => {
    try {
      const services = await getServices();
      const absolute = path.resolve(filePath); const stat = await fs.stat(absolute);
      if (!stat.isFile()) throw new Error("filePath must point to a file.");
      if (stat.size > 100 * 1024 * 1024) throw new Error("filePath must be 100 MB or smaller.");
      const response = await services.drive.files.create({ requestBody: { name: name ?? path.basename(absolute) }, media: { body: (await import("node:fs")).createReadStream(absolute) }, fields: "id,name,webViewLink" });
      return ok(JSON.stringify(response.data, null, 2));
    } catch (error) { return fail(error); }
  });
  server.tool("attach_file_to_submission", "Attach a Drive file to the student's Classroom submission. This does NOT turn it in — call turn_in_submission afterwards.", { courseId: z.string(), assignmentId: z.string(), fileId: z.string() }, async ({ courseId, assignmentId, fileId }) => {
    try {
      const services = await getServices();
      const response = await services.classroom.courses.courseWork.studentSubmissions.modifyAttachments({ courseId, courseWorkId: assignmentId, id: "me", requestBody: { addAttachments: [{ driveFile: { id: fileId } }] } });
      return ok(JSON.stringify(response.data, null, 2));
    } catch (error) { return fail(error); }
  });
  server.tool("turn_in_submission", "Turn in a submission. Destructive and final — only call after the student explicitly confirms this exact action. confirmation must be exactly: I confirm turn in", { courseId: z.string(), assignmentId: z.string(), confirmation: z.literal("I confirm turn in") }, async ({ courseId, assignmentId, confirmation }) => {
    try {
      const services = await getServices();
      if (confirmation !== "I confirm turn in") throw new Error("Explicit confirmation is required: I confirm turn in");
      await services.classroom.courses.courseWork.studentSubmissions.turnIn({ courseId, courseWorkId: assignmentId, id: "me", requestBody: {} });
      return ok("Assignment turned in.");
    } catch (error) { return fail(error); }
  });
  server.tool("whats_due", "What is due soon across all ACTIVE courses, with your turn-in state included. Answers 'do I have anything due' in one call — prefer over looping list_assignments. daysAhead 1-90 (default 14); limit 1-100 (default 50).", {
    daysAhead: z.number().min(1).max(90).optional(),
    limit: z.number().min(1).max(100).optional(),
    includeNoDueDate: z.boolean().optional(),
    includeTurnedIn: z.boolean().optional(),
  }, async (opts) => {
    try {
      const services = await getServices();
      return ok(JSON.stringify(await getWhatsDue(services, opts)));
    } catch (error) { return fail(error); }
  });
  server.tool("assignment_status", "Compact status of one assignment: turn-in state, grade, due date, materials, trimmed description. maxDescChars 0-2000 (default 300). Prefer over get_assignment.", {
    courseId: z.string(), assignmentId: z.string(), maxDescChars: z.number().min(0).max(2000).optional(),
  }, async ({ courseId, assignmentId, maxDescChars }) => {
    try {
      const services = await getServices();
      return ok(JSON.stringify(await getAssignmentStatus(services, courseId, assignmentId, maxDescChars ?? 300)));
    } catch (error) { return fail(error); }
  });
  server.tool("whats_new", "What is new (assignments, materials, announcements) across all ACTIVE courses since N days ago. Answers 'whats new on my classroom today' in one call. sinceDays 0-30 (default 1); limit 1-100 (default 30).", {
    sinceDays: z.number().min(0).max(30).optional(), limit: z.number().min(1).max(100).optional(),
  }, async (opts) => {
    try {
      const services = await getServices();
      return ok(JSON.stringify(await getWhatsNew(services, opts)));
    } catch (error) { return fail(error); }
  });
  return server;
}

export async function runServer(): Promise<void> {
  let cached: Promise<Services> | undefined;
  const getServices = () => (cached ??= createServices());
  const server = buildServer(getServices);
  await server.connect(new StdioServerTransport());
}
