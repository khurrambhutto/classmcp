import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServices, withRetry } from "./google.js";
import {
  getOverview,
  getAssignmentDetail,
  getMaterialDetail,
  getAnnouncementDetail,
  getCourseDetail,
  searchEverything,
  listCourses,
} from "./digest.js";
import { resolveCourse, resolveAssignment, resolveMaterial, resolveAnnouncement, type CourseRef, type AssignmentRef, type MaterialRef, type AnnouncementRef } from "./resolve.js";
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
  MaterialDetailSchema,
  AnnouncementDetailSchema,
  CourseDetailSchema,
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
      "window 1-30 (default 7); limit 1-50 (default 20); query filters title/course; detail=detailed adds links; " +
      "includeArchived=true also scans ARCHIVED courses (the result reports skippedArchived so narrowing is never silent). " +
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
  }, async ({ query, courseId, course, kinds, includeArchived, limit, detail }) => {
    try {
      const services = await getServices();
      let scopedCourseId: string | undefined;
      if (courseId || course) {
        const courseRes = await resolveCourse(services, { courseId, course } satisfies CourseRef);
        if (!courseRes.ok) return fail(new Error(courseRes.message));
        scopedCourseId = courseRes.item.id;
      }
      return ok(await searchEverything(services, {
        query, courseId: scopedCourseId, kinds, includeArchived, limit, detail,
      }));
    } catch (error) { return fail(error); }
  });

  server.registerTool("download_files", {
    title: "Download files",
    description:
      "Download an assignment's, material's, or announcement's handouts/attachments (or specific Drive fileIds) to disk in ONE call (max 20 files). " +
      "Google Docs/Sheets/Slides are exported (exportAs: pdf|docx|xlsx|pptx; defaults docx/xlsx/pptx) because raw " +
      "download fails on them. When fileIds is present, ONLY those files are downloaded (the scoped item's other " +
      "attachments are skipped). fileIds alone (no course/item) downloads exactly those Drive files. destinationDir " +
      "must resolve inside ~/Downloads or $CLASSMCP_WORKDIR (default <root>/classmcp); CLASSMCP_WORKDIR must be " +
      "exported in the MCP server's environment config and cannot be changed per call. Accepts course/assignment/material/announcement " +
      "names or ids. Per-file errors do not abort the rest.",
    inputSchema: DownloadInputShape,
    outputSchema: DownloadResultSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ courseId, course, assignmentId, assignment, materialId, material, announcementId, announcement, fileIds, destinationDir, exportAs }) => {
    try {
      const services = await getServices();
      const hasAssignmentRef = Boolean(assignmentId || assignment);
      const hasMaterialRef = Boolean(materialId || material);
      const hasAnnouncementRef = Boolean(announcementId || announcement);
      const refKinds = [hasAssignmentRef, hasMaterialRef, hasAnnouncementRef].filter(Boolean).length;
      if (refKinds > 1) {
        return fail(new Error("Pass only one of assignment, material, or announcement (plus course)."));
      }
      const hasItemRef = refKinds === 1;
      const requestedIds = [...new Set((fileIds ?? []).map((id) => id.trim()).filter(Boolean))];
      const scoped: DownloadItem[] = [];
      if (hasItemRef) {
        const courseRes = await resolveCourse(services, { courseId, course } satisfies CourseRef);
        if (!courseRes.ok) return fail(new Error(courseRes.message));
        const seen = new Set<string>();
        const pushAttachments = (attachments: Array<{ id: string | null; name: string | null; kind: "driveFile" | "form" | "link" | "youtube"; url: string | null }>) => {
          for (const attachment of attachments) {
            const key = attachment.id ?? attachment.url ?? attachment.name ?? "";
            if (!key || seen.has(key)) continue;
            seen.add(key);
            scoped.push({ fileId: attachment.id ?? key, name: attachment.name, kind: attachment.kind, url: attachment.url });
          }
        };
        if (hasMaterialRef) {
          const matRes = await resolveMaterial(services, courseRes.item.id, { materialId, material } satisfies MaterialRef);
          if (!matRes.ok) return fail(new Error(matRes.message));
          const detail = await getMaterialDetail(services, courseRes.item.id, courseRes.item.name, matRes.item.id);
          pushAttachments(detail.attachments);
        } else if (hasAnnouncementRef) {
          const annRes = await resolveAnnouncement(services, courseRes.item.id, { announcementId, announcement } satisfies AnnouncementRef);
          if (!annRes.ok) return fail(new Error(annRes.message));
          const detail = await getAnnouncementDetail(services, courseRes.item.id, courseRes.item.name, annRes.item.id);
          pushAttachments(detail.attachments);
        } else {
          const workRes = await resolveAssignment(services, courseRes.item.id, { assignmentId, assignment } satisfies AssignmentRef);
          if (workRes.ok) {
            const detail = await getAssignmentDetail(services, courseRes.item.id, courseRes.item.name, workRes.item.id, 0);
            pushAttachments([...detail.attachments, ...detail.myAttachments]);
          } else {
            // Fall back to materials/announcements so a material id or title passed
            // as assignmentId/assignment still resolves (search returns all kinds).
            const asMaterial = await resolveMaterial(services, courseRes.item.id, { materialId: assignmentId, material: assignment });
            if (asMaterial.ok) {
              const detail = await getMaterialDetail(services, courseRes.item.id, courseRes.item.name, asMaterial.item.id);
              pushAttachments(detail.attachments);
            } else {
              const asAnnouncement = await resolveAnnouncement(services, courseRes.item.id, { announcementId: assignmentId, announcement: assignment });
              if (asAnnouncement.ok) {
                const detail = await getAnnouncementDetail(services, courseRes.item.id, courseRes.item.name, asAnnouncement.item.id);
                pushAttachments(detail.attachments);
              } else {
                return fail(new Error(workRes.message));
              }
            }
          }
        }
      }
      let items: DownloadItem[];
      if (requestedIds.length > 0) {
        const byId = new Map(scoped.filter((s) => s.kind === "driveFile" || s.fileId).map((s) => [s.fileId, s]));
        const byUrl = new Map(scoped.map((s) => [s.url ?? "", s]));
        items = requestedIds.map((id) => {
          const known = byId.get(id) ?? (id.startsWith("http") ? byUrl.get(id) : undefined);
          if (known) return known;
          return { fileId: id, name: null, kind: "driveFile" as const, url: null };
        });
      } else {
        items = scoped;
      }
      if (items.length === 0) {
        return fail(new Error(hasItemRef
          ? "No attachments found on the scoped item. Pass fileIds to download specific Drive files."
          : "Provide an assignment, material, or announcement (course + item) or fileIds to download."));
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
    description: "JSON course reader: open and missing work, recent materials (with attachments), recent announcements, topics. {courseId} autocompletes from enrolled course names. Same shapes as the tools.",
    mimeType: "application/json",
  }, async (uri, variables) => {
    try {
      const courseId = String(variables.courseId ?? "");
      if (!courseId) throw new Error("courseId is required.");
      const services = await getServices();
      const body = await getCourseDetail(services, courseId);
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

  server.resource("material", new ResourceTemplate("classroom://courses/{courseId}/materials/{materialId}", {
    list: undefined,
    complete: {
      materialId: async (value, context) => {
        const courseId = context?.arguments?.courseId;
        if (!courseId) return [];
        const services = await getServices();
        const response = await withRetry(`courseWorkMaterials.list ${courseId}`, () => services.classroom.courses.courseWorkMaterials.list({ courseId, pageSize: 100 }));
        const q = value.trim().toLowerCase();
        return (response.data.courseWorkMaterial ?? [])
          .filter((m) => !q || (m.title ?? "").toLowerCase().includes(q))
          .map((m) => m.id ?? "")
          .filter(Boolean)
          .slice(0, 100);
      },
    },
  }), {
    title: "Material detail",
    description: "JSON reader for one course material: description, attachments with Drive file ids (pass to download_files), link. {materialId} autocompletes from material titles once courseId is known. Every search hit of kind=material is readable here.",
    mimeType: "application/json",
  }, async (uri, variables) => {
    try {
      const courseId = String(variables.courseId ?? "");
      const materialId = String(variables.materialId ?? "");
      if (!courseId || !materialId) throw new Error("courseId and materialId are required.");
      const services = await getServices();
      const courses = await listCourses(services, { includeArchived: true });
      const body = await getMaterialDetail(services, courseId, courses.find((c) => c.id === courseId)?.name ?? courseId, materialId);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
    } catch (error) {
      throw new Error(`Request failed: ${(error instanceof Error ? error.message : String(error)).replace(/[.]+$/, "")}.`);
    }
  });

  server.resource("announcement", new ResourceTemplate("classroom://courses/{courseId}/announcements/{announcementId}", {
    list: undefined,
    complete: {
      announcementId: async (value, context) => {
        const courseId = context?.arguments?.courseId;
        if (!courseId) return [];
        const services = await getServices();
        const response = await withRetry(`announcements.list ${courseId}`, () => services.classroom.courses.announcements.list({ courseId, pageSize: 100 }));
        const q = value.trim().toLowerCase();
        return (response.data.announcements ?? [])
          .filter((a) => !q || (a.text ?? "").toLowerCase().includes(q))
          .map((a) => a.id ?? "")
          .filter(Boolean)
          .slice(0, 100);
      },
    },
  }), {
    title: "Announcement detail",
    description: "JSON reader for one course announcement: full text, attachments with Drive file ids, link. {announcementId} autocompletes from announcement text once courseId is known. Every search hit of kind=announcement is readable here.",
    mimeType: "application/json",
  }, async (uri, variables) => {
    try {
      const courseId = String(variables.courseId ?? "");
      const announcementId = String(variables.announcementId ?? "");
      if (!courseId || !announcementId) throw new Error("courseId and announcementId are required.");
      const services = await getServices();
      const courses = await listCourses(services, { includeArchived: true });
      const body = await getAnnouncementDetail(services, courseId, courses.find((c) => c.id === courseId)?.name ?? courseId, announcementId);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
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
