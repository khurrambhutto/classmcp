import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServices, withRetry } from "./google.js";
import {
  getOverview,
  getAssignmentDetail,
  searchEverything,
  listCourses,
} from "./digest.js";
import { resolveCourse, resolveAssignment, type CourseRef, type AssignmentRef } from "./resolve.js";
import { downloadMany, uploadLocalFiles, type DownloadItem } from "./files.js";
import {
  OverviewInputShape,
  AssignmentInputShape,
  SearchInputShape,
  DownloadInputShape,
  SubmitInputShape,
  OverviewResultSchema,
  AssignmentDetailSchema,
  SearchResultSchema,
  DownloadResultSchema,
  SubmitResultSchema,
} from "./schemas.js";

type Services = Awaited<ReturnType<typeof createServices>>;

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(error: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/[.]+$/, "");
  const hint = /auth|token|unauthorized|invalid_grant/i.test(message) ? " Run `classmcp setup` to reconnect Google." : "";
  return { content: [{ type: "text" as const, text: `Request failed: ${message}.${hint}` }], isError: true as const };
}

function isProjectDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ProjectPermissionDenied|Developer Console project/i.test(message);
}

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const;

export function buildServer(getServices: () => Promise<Services>): McpServer {
  const server = new McpServer({ name: "classmcp", version: "0.2.0" }, {
    instructions:
      "Student-side Google Classroom. Start with get_overview (due/missing/new/grades/courses); drill into get_assignment; " +
      "find items with search; fetch handouts with download_files; submit_work uploads to Drive and, when Google blocks " +
      "attach/turn-in (it usually does: only the app that created an assignment may modify submissions), returns links to " +
      "finish in the Classroom UI. Tools accept course names or ids and assignment title fragments or ids. Row ids are " +
      "stable and can be passed to follow-up calls.",
  });

  server.registerTool("get_overview", {
    title: "Classroom overview",
    description:
      "Daily driver: what is due, missing, new, or graded across all courses in ONE call, plus a course id index. " +
      "Prefer over listing assignments per course. view=due (default) = upcoming open work due within `window`, " +
      "soonest first (overdue work is NOT here); view=missing = overdue/late only, most recently due first; " +
      "view=new = updates in the last `window` days; view=grades = scored work; view=courses = course ids. " +
      "window 1-30 (default 7); limit 1-50 (default 20); query filters title/course; detail=detailed adds links. " +
      "Returns truncated+hint when capped (the hint also steers to view=missing when overdue items exist); " +
      "errors[] lists per-course failures without failing the call.",
    inputSchema: OverviewInputShape,
    outputSchema: OverviewResultSchema,
    annotations: READ_ONLY,
  }, async (args) => {
    try {
      const services = await getServices();
      return ok(await getOverview(services, args));
    } catch (error) { return fail(error); }
  });

  server.registerTool("get_assignment", {
    title: "Get assignment",
    description:
      "Full detail of ONE assignment in one call: prompt (trimmed to maxDescChars), due date and days left, your " +
      "turn-in state, grade, rubric criteria, teacher attachments with Drive file ids (pass to download_files), your " +
      "attached files, and recent submission history. Accepts course name or id and assignment title fragment or id " +
      "— no discovery call needed. maxDescChars 0-2000 (default 400). Prefer over get_overview when the user names " +
      "one assignment.",
    inputSchema: AssignmentInputShape,
    outputSchema: AssignmentDetailSchema,
    annotations: READ_ONLY,
  }, async ({ courseId, course, assignmentId, assignment, maxDescChars }) => {
    try {
      const services = await getServices();
      const courseRes = await resolveCourse(services, { courseId, course } satisfies CourseRef);
      if (!courseRes.ok) return fail(new Error(courseRes.message));
      const workRes = await resolveAssignment(services, courseRes.item.id, { assignmentId, assignment } satisfies AssignmentRef);
      if (!workRes.ok) return fail(new Error(workRes.message));
      return ok(await getAssignmentDetail(services, courseRes.item.id, courseRes.item.name, workRes.item.id, maxDescChars ?? 400));
    } catch (error) { return fail(error); }
  });

  server.registerTool("search", {
    title: "Search classroom",
    description:
      "Keyword search across assignments, materials, and announcements (titles, descriptions, announcement text). " +
      "ALL words must match. Answers 'which assignment was about X?' in one call — prefer over scanning get_overview " +
      "pages. Optional course filter; kinds narrows to assignment/material/announcement; limit 1-30 (default 10). " +
      "Returns trimmed match snippets with ids for follow-up calls.",
    inputSchema: SearchInputShape,
    outputSchema: SearchResultSchema,
    annotations: READ_ONLY,
  }, async ({ query, courseId, course, kinds, limit, detail }) => {
    try {
      const services = await getServices();
      let scopedCourseId: string | undefined;
      if (courseId || course) {
        const courseRes = await resolveCourse(services, { courseId, course } satisfies CourseRef);
        if (!courseRes.ok) return fail(new Error(courseRes.message));
        scopedCourseId = courseRes.item.id;
      }
      return ok(await searchEverything(services, {
        query, courseId: scopedCourseId, kinds, limit, detail,
      }));
    } catch (error) { return fail(error); }
  });

  server.registerTool("download_files", {
    title: "Download files",
    description:
      "Download an assignment's handouts/attachments (or specific Drive fileIds) to disk in ONE call (max 20 files). " +
      "Google Docs/Sheets/Slides are exported (exportAs: pdf|docx|xlsx|pptx; defaults docx/xlsx/pptx) because raw " +
      "download fails on them. destinationDir must resolve inside ~/Downloads or $CLASSMCP_WORKDIR (default " +
      "<root>/classmcp). Accepts course/assignment names or ids. Per-file errors do not abort the rest.",
    inputSchema: DownloadInputShape,
    outputSchema: DownloadResultSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ courseId, course, assignmentId, assignment, fileIds, destinationDir, exportAs }) => {
    try {
      const services = await getServices();
      const items: DownloadItem[] = [];
      if (courseId || course || assignmentId || assignment) {
        const courseRes = await resolveCourse(services, { courseId, course } satisfies CourseRef);
        if (!courseRes.ok) return fail(new Error(courseRes.message));
        const workRes = await resolveAssignment(services, courseRes.item.id, { assignmentId, assignment } satisfies AssignmentRef);
        if (!workRes.ok) return fail(new Error(workRes.message));
        const detail = await getAssignmentDetail(services, courseRes.item.id, courseRes.item.name, workRes.item.id, 0);
        const seen = new Set<string>();
        for (const attachment of [...detail.attachments, ...detail.myAttachments]) {
          const key = attachment.id ?? attachment.url ?? attachment.name ?? "";
          if (!key || seen.has(key)) continue;
          seen.add(key);
          items.push({ fileId: attachment.id ?? key, name: attachment.name, kind: attachment.kind, url: attachment.url });
        }
      }
      for (const id of fileIds ?? []) {
        if (!items.some((item) => item.fileId === id)) items.push({ fileId: id, name: null, kind: "driveFile", url: null });
      }
      if (items.length === 0) {
        return fail(new Error("Provide an assignment (course + assignment) or fileIds to download."));
      }
      return ok(await downloadMany(services.drive, items, { destinationDir, exportAs }));
    } catch (error) { return fail(error); }
  });

  server.registerTool("submit_work", {
    title: "Submit work",
    description:
      "Best-effort submission helper. Uploads local files to Drive (this always works), then attempts to attach them " +
      "to the assignment and optionally turn in. Google only permits the app that created an assignment to modify " +
      "submissions, so on teacher-created work attach/turn-in return blocked:true and the result includes Drive links " +
      "plus the Classroom assignment link to finish in the UI. turnIn defaults to false (attach only); turnIn=true " +
      "requires confirmTurnIn=\"I confirm turn in\". Question-type (short answer / multiple choice) answers cannot be " +
      "set via API at all.",
    inputSchema: SubmitInputShape,
    outputSchema: SubmitResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ courseId, course, assignmentId, assignment, files, fileIds, link, turnIn, confirmTurnIn }) => {
    try {
      const services = await getServices();
      if (turnIn && confirmTurnIn !== "I confirm turn in") {
        return fail(new Error("turnIn requires confirmTurnIn to be exactly: I confirm turn in"));
      }
      const hasWork = (files?.length ?? 0) > 0 || (fileIds?.length ?? 0) > 0 || Boolean(link) || Boolean(turnIn);
      if (!hasWork) {
        return fail(new Error("Provide files, fileIds, or link to attach, or set turnIn with confirmTurnIn."));
      }
      const courseRes = await resolveCourse(services, { courseId, course } satisfies CourseRef);
      if (!courseRes.ok) return fail(new Error(courseRes.message));
      const workRes = await resolveAssignment(services, courseRes.item.id, { assignmentId, assignment } satisfies AssignmentRef);
      if (!workRes.ok) return fail(new Error(workRes.message));
      const work = workRes.item;

      const uploaded = files?.length ? await uploadLocalFiles(services.drive, files) : [];
      const addAttachments = [
        ...uploaded.filter((item) => item.id).map((item) => ({ driveFile: { id: item.id as string } })),
        ...(fileIds ?? []).map((id) => ({ driveFile: { id } })),
        ...(link ? [{ link: { url: link.url, ...(link.title ? { title: link.title } : {}) } }] : []),
      ];

      let attached = false;
      let turnedIn = false;
      let blocked = false;
      const notes: string[] = [];
      for (const item of uploaded) {
        if (item.error) notes.push(`Upload failed for ${item.name}: ${item.error}`);
      }

      if (addAttachments.length > 0) {
        try {
          await withRetry(`modifyAttachments ${work.id}`, () =>
            services.classroom.courses.courseWork.studentSubmissions.modifyAttachments({
              courseId: courseRes.item.id, courseWorkId: work.id, id: "me",
              requestBody: { addAttachments },
            }));
          attached = true;
        } catch (error) {
          if (isProjectDenied(error)) {
            blocked = true;
            notes.push("Google rejected the attachment: only the app that created an assignment may modify submissions.");
          } else {
            notes.push(`Attach failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      if (turnIn) {
        try {
          await withRetry(`turnIn ${work.id}`, () =>
            services.classroom.courses.courseWork.studentSubmissions.turnIn({
              courseId: courseRes.item.id, courseWorkId: work.id, id: "me", requestBody: {},
            }));
          turnedIn = true;
        } catch (error) {
          if (isProjectDenied(error)) {
            blocked = true;
            notes.push("Google rejected the turn-in: only the app that created an assignment may modify submissions.");
          } else {
            notes.push(`Turn-in failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      let myState = "NEW";
      try {
        const subs = await withRetry(`submissions.list ${work.id}`, () =>
          services.classroom.courses.courseWork.studentSubmissions.list({
            courseId: courseRes.item.id, courseWorkId: work.id, userId: "me", pageSize: 1,
          }));
        myState = subs.data.studentSubmissions?.[0]?.state ?? "NEW";
      } catch { /* state is best-effort */ }

      const uploadedOk = uploaded.filter((item) => !item.error).length;
      const assignmentUrl = await assignmentLink(services, courseRes.item.id, work.id);
      let message: string;
      if (blocked) {
        message =
          `Uploaded ${uploadedOk} file(s) to Drive. ${notes.join(" ")} ` +
          `Finish in Classroom (about 15 seconds): open ${work.title} at ` +
          `${assignmentUrl} — add the file from Drive, then click Turn in.`;
      } else if (turnedIn) {
        message = `Attached ${addAttachments.length} item(s) and turned in ${work.title}.`;
      } else if (attached) {
        message = `Attached ${addAttachments.length} item(s) to ${work.title}. Not turned in; set turnIn=true with confirmTurnIn to finish.`;
      } else {
        message = notes.length > 0 ? notes.join(" ") : "Nothing was attached.";
      }

      return ok({
        courseId: courseRes.item.id,
        assignmentId: work.id,
        title: work.title,
        assignmentLink: assignmentUrl,
        uploaded,
        attached,
        turnedIn,
        myState,
        blocked,
        message,
      });
    } catch (error) { return fail(error); }
  });

  // --- Resources: stable addresses for course data + name autocomplete ---

  server.resource("course", new ResourceTemplate("classroom://courses/{courseId}", {
    list: async () => {
      const services = await getServices();
      const courses = await listCourses(services, { includeArchived: true });
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
        const courses = await listCourses(services, { includeArchived: true });
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
      const courses = await listCourses(services, { includeArchived: true });
      const course = courses.find((c) => c.id === courseId);
      const overview = await getOverview(services, { view: "due", window: 30, limit: 20 });
      const body = {
        id: courseId,
        name: course?.name ?? null,
        section: course?.section ?? null,
        state: course?.state ?? null,
        openWork: overview.items.filter((item) => "courseId" in item && item.courseId === courseId),
      };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
    } catch (error) {
      throw new Error(`Request failed: ${(error instanceof Error ? error.message : String(error)).replace(/[.]+$/, "")}.`);
    }
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
    description: "Compact JSON status of one assignment: turn-in state, grade, due date, attachments. {assignmentId} autocompletes from assignment titles once courseId is known.",
    mimeType: "application/json",
  }, async (uri, variables) => {
    try {
      const courseId = String(variables.courseId ?? "");
      const assignmentId = String(variables.assignmentId ?? "");
      if (!courseId || !assignmentId) throw new Error("courseId and assignmentId are required.");
      const services = await getServices();
      const courses = await listCourses(services, { includeArchived: true });
      const status = await getAssignmentDetail(services, courseId, courses.find((c) => c.id === courseId)?.name ?? courseId, assignmentId, 1000);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(status, null, 2) }] };
    } catch (error) {
      throw new Error(`Request failed: ${(error instanceof Error ? error.message : String(error)).replace(/[.]+$/, "")}.`);
    }
  });

  return server;
}

async function assignmentLink(services: Services, courseId: string, assignmentId: string): Promise<string> {
  try {
    const work = await withRetry(`courseWork.get ${assignmentId}`, () =>
      services.classroom.courses.courseWork.get({ courseId, id: assignmentId }));
    return work.data.alternateLink ?? `https://classroom.google.com/c/${courseId}`;
  } catch {
    return `https://classroom.google.com/c/${courseId}`;
  }
}

export async function runServer(): Promise<void> {
  let cached: Promise<Services> | undefined;
  const getServices = () => (cached ??= createServices());
  const server = buildServer(getServices);
  await server.connect(new StdioServerTransport());
}
