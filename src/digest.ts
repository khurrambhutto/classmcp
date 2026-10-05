import type { classroom_v1 } from "googleapis";
import type { GoogleServices } from "./google.js";
import { withRetry } from "./google.js";
import { mapPool } from "./util.js";
import type {
  AnnouncementDetail, AnnouncementSummary, Attachment, AssignmentDetail, CourseDetail,
  CourseRow, MaterialDetail, MaterialSummary, NewRow, OverviewResult,
  PartialError, RubricCriterion, SearchHit, SearchResult, WorkRow,
} from "./schemas.js";

type HistoryEntry = NonNullable<AssignmentDetail["history"]>[number];

export type OverviewOptions = { view?: "due" | "missing" | "new" | "grades" | "courses"; window?: number; limit?: number; query?: string | undefined; includeArchived?: boolean; detail?: "concise" | "detailed" };
export type SearchOptions = { query: string; courseId?: string | undefined; kinds?: Array<"assignment" | "material" | "announcement">; includeArchived?: boolean; limit?: number; detail?: "concise" | "detailed" };

export function dueToMillis(
  dueDate?: classroom_v1.Schema$Date | null,
  dueTime?: classroom_v1.Schema$TimeOfDay | null,
): number | undefined {
  if (!dueDate?.year || !dueDate?.month || !dueDate?.day) return undefined;
  return Date.UTC(
    dueDate.year,
    dueDate.month - 1,
    dueDate.day,
    dueTime?.hours ?? 0,
    dueTime?.minutes ?? 0,
  );
}

export function dueToDay(dueDate?: classroom_v1.Schema$Date | null): string | null {
  if (!dueDate?.year || !dueDate?.month || !dueDate?.day) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dueDate.year}-${pad(dueDate.month)}-${pad(dueDate.day)}`;
}

export function daysUntil(dueMillis: number, nowMillis: number): number {
  return Math.ceil((dueMillis - nowMillis) / 86_400_000);
}

export function trimText(text: string | null | undefined, max: number): string {
  const value = (text ?? "").trim().replace(/\s+/g, " ");
  if (value.length <= max) return value;
  return value.slice(0, max).trimEnd() + "…";
}

export type Trimmed = { value: string; status: "full" | "trimmed" | "empty" };

export function trimWithStatus(text: string | null | undefined, max: number): Trimmed {
  const value = (text ?? "").trim().replace(/\s+/g, " ");
  if (!value) return { value: "", status: "empty" };
  if (value.length <= max) return { value, status: "full" };
  return { value: value.slice(0, max).trimEnd() + "…", status: "trimmed" };
}

function isDenied(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === 401 || code === 403 || /permission|denied|forbidden/i.test(message);
}

export function summarizeMaterial(m: classroom_v1.Schema$Material): string {
  const drive = m.driveFile as { driveFile?: { title?: string | null } } | undefined;
  if (drive?.driveFile?.title) return `drive:${drive.driveFile.title}`;
  if (m.form) return `form:${(m.form as { title?: string | null }).title ?? "form"}`;
  if (m.link) return `link:${(m.link as { url?: string | null }).url ?? ""}`;
  if (m.youtubeVideo) return `video:${(m.youtubeVideo as { title?: string | null }).title ?? "youtube"}`;
  return "file:attachment";
}

const DONE_STATES = new Set(["TURNED_IN", "RETURNED"]);

export async function listCourses(services: GoogleServices, opts: { includeArchived?: boolean } = {}): Promise<CourseRow[]> {
  const includeArchived = opts.includeArchived ?? true;
  const courses: CourseRow[] = [];
  let pageToken: string | undefined;
  do {
    const response = await withRetry("courses.list", () => services.classroom.courses.list({
      studentId: "me",
      courseStates: includeArchived ? ["ACTIVE", "ARCHIVED"] : ["ACTIVE"],
      pageSize: 100,
      pageToken,
    }));
    for (const c of response.data.courses ?? []) {
      if (c.id) courses.push({ id: c.id, name: c.name ?? "Unnamed", section: c.section ?? null, state: c.courseState ?? null });
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  return courses.sort(compareCourses);
}

function compareCourses(a: CourseRow, b: CourseRow): number {
  const rank = (row: CourseRow) => (row.state === "ACTIVE" ? 0 : 1);
  return rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" ? (value as Rec) : null;
}

function str(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

// Accepts googleapis Material ({driveFile:{driveFile:…}, form, link, youtubeVideo})
// OR Attachment ({driveFile:…, form, link, youTubeVideo}) — the two nest differently.
export function normalizeAttachments(materials: Array<unknown>): Attachment[] {
  const out: Attachment[] = [];
  for (const raw of materials) {
    const m = rec(raw);
    if (!m) continue;
    const drive = rec(rec(m.driveFile)?.driveFile) ?? rec(m.driveFile);
    if (drive) {
      out.push({ kind: "driveFile", id: str(drive.id), name: str(drive.title), url: null });
      continue;
    }
    const form = rec(m.form);
    if (form) {
      out.push({ kind: "form", id: null, name: str(form.title), url: str(form.formUrl, form.responderUri, form.alternateLink) });
      continue;
    }
    const link = rec(m.link);
    if (link) {
      out.push({ kind: "link", id: null, name: str(link.title), url: str(link.url) });
      continue;
    }
    const video = rec(rec(m.youtubeVideo)?.youtubeVideo) ?? rec(m.youtubeVideo)
      ?? rec(rec(m.youTubeVideo)?.youtubeVideo) ?? rec(m.youTubeVideo);
    if (video) {
      const id = str(video.id);
      out.push({
        kind: "youtube", id, name: str(video.title),
        url: str(video.alternateLink, id ? `https://www.youtube.com/watch?v=${id}` : null),
      });
      continue;
    }
  }
  return out;
}

function workComparator(view: "due" | "missing" | "grades"): (a: WorkRow, b: WorkRow) => number {
  if (view === "grades") {
    return (a, b) => a.course.localeCompare(b.course) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  }
  if (view === "missing") {
    return (a, b) => {
      const da = a.daysLeft ?? Number.NEGATIVE_INFINITY;
      const db = b.daysLeft ?? Number.NEGATIVE_INFINITY;
      return db - da || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    };
  }
  return (a, b) => {
    const da = a.daysLeft ?? Number.POSITIVE_INFINITY;
    const db = b.daysLeft ?? Number.POSITIVE_INFINITY;
    return da - db || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  };
}

export function buildWorkRows(course: { id: string; name: string }, work: unknown[], subs: unknown[], view: "due" | "missing" | "grades", window: number, nowMillis: number, detail: "concise" | "detailed"): WorkRow[] {
  const subByWork = new Map<string, classroom_v1.Schema$StudentSubmission>();
  for (const raw of subs) {
    const sub = raw as classroom_v1.Schema$StudentSubmission;
    if (sub?.courseWorkId) subByWork.set(sub.courseWorkId, sub);
  }
  const rows: WorkRow[] = [];
  for (const raw of work) {
    const w = raw as classroom_v1.Schema$CourseWork;
    if (!w?.id) continue;
    const sub = subByWork.get(w.id);
    const myState = sub?.state ?? "NEW";
    const late = sub?.late ?? false;
    const grade = sub?.assignedGrade ?? null;
    const dueMillis = dueToMillis(w.dueDate, w.dueTime);
    const daysLeft = dueMillis !== undefined ? daysUntil(dueMillis, nowMillis) : null;
    const open = !DONE_STATES.has(myState);
    if (view === "due") {
      if (!open) continue;
      if (dueMillis !== undefined && ((daysLeft ?? 0) < 0 || (daysLeft ?? 0) > window)) continue;
    } else if (view === "missing") {
      if (!open) continue;
      if (!(late || (dueMillis !== undefined && (daysLeft ?? 0) < 0))) continue;
    } else if (grade === null) {
      continue;
    }
    const row: WorkRow = {
      course: course.name,
      courseId: course.id,
      id: w.id,
      title: trimText(w.title, 140),
      due: dueToDay(w.dueDate) ?? "none",
      daysLeft,
      myState,
      late,
      points: w.maxPoints ?? null,
      grade,
    };
    if (detail === "detailed") {
      row.link = w.alternateLink ?? undefined;
      row.workType = w.workType ?? undefined;
    }
    rows.push(row);
  }
  return rows.sort(workComparator(view));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wrapOverview(view: OverviewResult["view"], window: number, checkedCourses: number, skippedArchived: number, total: number, items: Array<WorkRow | NewRow | CourseRow>, errors: PartialError[], steer?: string): OverviewResult {
  const returned = items.length;
  const truncated = total > returned;
  const parts: string[] = [];
  if (truncated) parts.push(`Showing ${returned} of ${total}. Narrow with a smaller window, query="...", or a different view.`);
  if (steer) parts.push(steer);
  return {
    view, window, checkedCourses, skippedArchived, total, returned, truncated,
    hint: parts.length > 0 ? parts.join(" ") : null,
    errors,
    items,
  };
}

export async function getOverview(services: GoogleServices, opts: OverviewOptions = {}, nowMillis = Date.now()): Promise<OverviewResult> {
  const view = opts.view ?? "due";
  const window = opts.window ?? 7;
  const limit = opts.limit ?? 20;
  const detail = opts.detail ?? "concise";
  const query = opts.query?.trim().toLowerCase() ?? "";
  const errors: PartialError[] = [];

  const allCourses = await listCourses(services, { includeArchived: true });
  const includeArchived = Boolean(opts.includeArchived) || view === "grades" || view === "courses";
  const courses = includeArchived ? allCourses : allCourses.filter((c) => c.state === "ACTIVE");
  const skippedArchived = allCourses.length - courses.length;

  if (view === "courses") {
    const matched = query ? courses.filter((c) => c.name.toLowerCase().includes(query)) : courses;
    return wrapOverview(view, window, courses.length, 0, matched.length, matched.slice(0, limit), errors);
  }

  if (view === "new") {
    const since = nowMillis - window * 86_400_000;
    const perCourse = await mapPool(courses, 5, async (course): Promise<NewRow[]> => {
      try {
        const [work, materials, announcements] = await Promise.all([
          withRetry(`courseWork.list ${course.id}`, () => services.classroom.courses.courseWork.list({
            courseId: course.id, courseWorkStates: ["PUBLISHED"], orderBy: "updateTime desc", pageSize: 20,
          })),
          withRetry(`courseWorkMaterials.list ${course.id}`, () => services.classroom.courses.courseWorkMaterials.list({ courseId: course.id, pageSize: 20 })),
          withRetry(`announcements.list ${course.id}`, () => services.classroom.courses.announcements.list({ courseId: course.id, pageSize: 20 })),
        ]);
        const rows: NewRow[] = [];
        const push = (type: NewRow["type"], id: string | null | undefined, title: string | null | undefined, updated: string | null | undefined) => {
          if (!id || !updated || Date.parse(updated) < since) return;
          rows.push({ type, course: course.name, courseId: course.id, id, title: trimText(title, 140), updated });
        };
        for (const w of work.data.courseWork ?? []) push("assignment", w.id, w.title, w.updateTime ?? w.creationTime);
        for (const m of materials.data.courseWorkMaterial ?? []) push("material", m.id, m.title, m.updateTime ?? m.creationTime);
        for (const a of announcements.data.announcements ?? []) push("announcement", a.id, a.text, a.updateTime ?? a.creationTime);
        return rows;
      } catch (error) {
        errors.push({ courseId: course.id, course: course.name, message: errorMessage(error) });
        return [];
      }
    });
    const all = perCourse.flat().sort((a, b) => (Date.parse(b.updated ?? "") || 0) - (Date.parse(a.updated ?? "") || 0));
    const matched = query ? all.filter((r) => r.title.toLowerCase().includes(query) || r.course.toLowerCase().includes(query)) : all;
    if (errors.length > 0 && errors.length === courses.length && matched.length === 0) throw new Error(errors[0].message);
    return wrapOverview(view, window, courses.length, skippedArchived, matched.length, matched.slice(0, limit), errors);
  }

  let missingCount = 0;
  const perCourse = await mapPool(courses, 5, async (course): Promise<WorkRow[]> => {
    try {
      const [work, subs] = await Promise.all([
        withRetry(`courseWork.list ${course.id}`, () => services.classroom.courses.courseWork.list({
          courseId: course.id, courseWorkStates: ["PUBLISHED"], orderBy: "dueDate asc", pageSize: 100,
        })),
        withRetry(`submissions.list ${course.id}`, () => services.classroom.courses.courseWork.studentSubmissions.list({
          courseId: course.id, courseWorkId: "-", userId: "me", pageSize: 100,
        })),
      ]);
      const rows = buildWorkRows(course, work.data.courseWork ?? [], subs.data.studentSubmissions ?? [], view, window, nowMillis, detail);
      if (view === "due") {
        missingCount += buildWorkRows(course, work.data.courseWork ?? [], subs.data.studentSubmissions ?? [], "missing", window, nowMillis, detail).length;
      }
      return rows;
    } catch (error) {
      errors.push({ courseId: course.id, course: course.name, message: errorMessage(error) });
      return [];
    }
  });
  const all = perCourse.flat().sort(workComparator(view));
  const matched = query ? all.filter((r) => r.title.toLowerCase().includes(query) || r.course.toLowerCase().includes(query)) : all;
  if (errors.length > 0 && errors.length === courses.length && matched.length === 0) throw new Error(errors[0].message);
  const steer = view === "due" && missingCount > 0
    ? `${missingCount} overdue/late item(s) are in view=missing.`
    : undefined;
  return wrapOverview(view, window, courses.length, skippedArchived, matched.length, matched.slice(0, limit), errors, steer);
}

function mapCriterion(c: classroom_v1.Schema$Criterion): RubricCriterion {
  const levels = (c.levels ?? []).map((level) => ({
    label: level.description ?? level.title ?? "",
    points: level.points ?? null,
  }));
  const levelPoints = levels.map((level) => level.points).filter((p): p is number => p !== null);
  return {
    criterion: c.description ?? c.title ?? c.id ?? "",
    points: levelPoints.length > 0 ? Math.max(...levelPoints) : null,
    levels,
  };
}

function mapHistory(history: classroom_v1.Schema$SubmissionHistory[] | null | undefined): HistoryEntry[] | null {
  if (!history) return null;
  const entries: HistoryEntry[] = [];
  for (const entry of history) {
    const state = entry?.stateHistory;
    if (!state) continue;
    entries.push({ state: state.state ?? "", at: state.stateTimestamp ?? null });
  }
  return entries.slice(-5);
}

export async function getAssignmentDetail(services: GoogleServices, courseId: string, courseName: string, assignmentId: string, maxDescChars = 400, nowMillis = Date.now()): Promise<AssignmentDetail> {
  const [work, subs] = await Promise.all([
    withRetry(`courseWork.get ${assignmentId}`, () => services.classroom.courses.courseWork.get({ courseId, id: assignmentId })),
    withRetry(`studentSubmissions.list ${assignmentId}`, () => services.classroom.courses.courseWork.studentSubmissions.list({
      courseId, courseWorkId: assignmentId, userId: "me", pageSize: 1,
    })),
  ]);
  const w = work.data;
  const sub = subs.data.studentSubmissions?.[0];

  let rubric: RubricCriterion[] | null = null;
  let rubricStatus: AssignmentDetail["rubricStatus"] = "none";
  try {
    const response = await withRetry(`rubrics.list ${assignmentId}`, () => services.classroom.courses.courseWork.rubrics.list({ courseId, courseWorkId: assignmentId }));
    const criteria = response.data.rubrics?.[0]?.criteria;
    if (criteria && criteria.length > 0) {
      rubric = criteria.map(mapCriterion);
      rubricStatus = "present";
    }
  } catch (error) {
    rubric = null;
    rubricStatus = isDenied(error) ? "denied" : "error";
  }

  let topic: string | null = null;
  let topicStatus: AssignmentDetail["topicStatus"] = "none";
  const topicId = w.topicId;
  if (topicId) {
    try {
      const response = await withRetry(`topics.get ${topicId}`, () => services.classroom.courses.topics.get({ courseId, id: topicId }));
      topic = response.data.name ?? null;
      topicStatus = topic ? "present" : "none";
    } catch (error) {
      topic = null;
      topicStatus = isDenied(error) ? "denied" : "error";
    }
  }

  let history: HistoryEntry[] | null = null;
  let historyStatus: AssignmentDetail["historyStatus"] = "unavailable";
  if (sub?.id) {
    try {
      const full = await withRetry(`submissions.get ${assignmentId}`, () => services.classroom.courses.courseWork.studentSubmissions.get({
        courseId, courseWorkId: assignmentId, id: sub.id as string,
      }));
      const mapped = mapHistory(full.data.submissionHistory ?? sub.submissionHistory);
      if (mapped) {
        history = mapped;
        historyStatus = mapped.length > 0 ? "present" : "none";
      }
    } catch {
      const mapped = mapHistory(sub.submissionHistory);
      if (mapped) {
        history = mapped;
        historyStatus = mapped.length > 0 ? "present" : "none";
      }
    }
  }

  const prompt = trimWithStatus(w.description, maxDescChars);
  const dueMillis = dueToMillis(w.dueDate, w.dueTime);
  return {
    courseId,
    course: courseName,
    id: assignmentId,
    title: trimText(w.title, 200),
    workType: w.workType ?? null,
    prompt: prompt.value,
    promptStatus: prompt.status,
    due: dueToDay(w.dueDate),
    daysLeft: dueMillis !== undefined ? daysUntil(dueMillis, nowMillis) : null,
    points: w.maxPoints ?? null,
    myState: sub?.state ?? "NEW",
    late: sub?.late ?? false,
    grade: sub?.assignedGrade ?? null,
    link: w.alternateLink ?? null,
    topic,
    topicStatus,
    rubric,
    rubricStatus,
    attachments: normalizeAttachments(w.materials ?? []),
    myAttachments: normalizeAttachments(sub?.assignmentSubmission?.attachments ?? []),
    history,
    historyStatus,
  };
}

export async function getMaterialDetail(services: GoogleServices, courseId: string, courseName: string, materialId: string, maxDescChars = 2000): Promise<MaterialDetail> {
  const response = await withRetry(`courseWorkMaterials.get ${materialId}`, () =>
    services.classroom.courses.courseWorkMaterials.get({ courseId, id: materialId }));
  const m = response.data;
  const description = trimWithStatus(m.description, maxDescChars);
  return {
    kind: "material",
    courseId,
    course: courseName,
    id: materialId,
    title: trimText(m.title, 200),
    description: description.value,
    descriptionStatus: description.status,
    attachments: normalizeAttachments(m.materials ?? []),
    link: m.alternateLink ?? null,
    created: m.creationTime ?? null,
    updated: m.updateTime ?? null,
  };
}

export async function getAnnouncementDetail(services: GoogleServices, courseId: string, courseName: string, announcementId: string, maxDescChars = 2000): Promise<AnnouncementDetail> {
  const response = await withRetry(`announcements.get ${announcementId}`, () =>
    services.classroom.courses.announcements.get({ courseId, id: announcementId }));
  const a = response.data;
  const text = trimWithStatus(a.text, maxDescChars);
  return {
    kind: "announcement",
    courseId,
    course: courseName,
    id: announcementId,
    text: text.value,
    textStatus: text.status,
    attachments: normalizeAttachments(a.materials ?? []),
    link: a.alternateLink ?? null,
    created: a.creationTime ?? null,
    updated: a.updateTime ?? null,
  };
}

const COURSE_DETAIL_CAP = 20;

export async function getCourseDetail(services: GoogleServices, courseId: string, nowMillis = Date.now()): Promise<CourseDetail> {
  const courses = await listCourses(services, { includeArchived: true });
  const info = courses.find((c) => c.id === courseId);
  if (!info) throw new Error(`No course with id "${courseId}".`);
  const errors: PartialError[] = [];

  const [workSubs, materialsRes, announcementsRes] = await Promise.all([
    (async () => {
      try {
        const [work, subs] = await Promise.all([
          withRetry(`courseWork.list ${courseId}`, () => services.classroom.courses.courseWork.list({
            courseId, courseWorkStates: ["PUBLISHED"], orderBy: "dueDate asc", pageSize: 100,
          })),
          withRetry(`submissions.list ${courseId}`, () => services.classroom.courses.courseWork.studentSubmissions.list({
            courseId, courseWorkId: "-", userId: "me", pageSize: 100,
          })),
        ]);
        return {
          work: work.data.courseWork ?? [],
          subs: subs.data.studentSubmissions ?? [],
        };
      } catch (error) {
        errors.push({ courseId, course: info.name, message: errorMessage(error) });
        return { work: [], subs: [] };
      }
    })(),
    (async () => {
      try {
        const response = await withRetry(`courseWorkMaterials.list ${courseId}`, () =>
          services.classroom.courses.courseWorkMaterials.list({ courseId, pageSize: 100 }));
        return response.data.courseWorkMaterial ?? [];
      } catch (error) {
        errors.push({ courseId, course: info.name, message: errorMessage(error) });
        return [];
      }
    })(),
    (async () => {
      try {
        const response = await withRetry(`announcements.list ${courseId}`, () =>
          services.classroom.courses.announcements.list({ courseId, pageSize: 100 }));
        return response.data.announcements ?? [];
      } catch (error) {
        errors.push({ courseId, course: info.name, message: errorMessage(error) });
        return [];
      }
    })(),
  ]);

  let topics: Array<{ id: string; name: string }> | null = null;
  let topicsStatus: CourseDetail["topicsStatus"] = "none";
  try {
    const response = await withRetry(`topics.list ${courseId}`, () => services.classroom.courses.topics.list({ courseId }));
    const rows = (response.data.topic ?? [])
      .filter((t): t is classroom_v1.Schema$Topic & { topicId: string } => Boolean(t?.topicId))
      .map((t) => ({ id: t.topicId, name: t.name ?? "Unnamed" }));
    topics = rows;
    topicsStatus = rows.length > 0 ? "present" : "none";
  } catch (error) {
    topics = null;
    topicsStatus = isDenied(error) ? "denied" : "error";
  }

  const courseRef = { id: info.id, name: info.name };
  const openWork = buildWorkRows(courseRef, workSubs.work, workSubs.subs, "due", 365, nowMillis, "concise");
  const missing = buildWorkRows(courseRef, workSubs.work, workSubs.subs, "missing", 365, nowMillis, "concise");

  const materials: MaterialSummary[] = materialsRes.map((m) => ({
    id: m.id ?? "",
    title: trimText(m.title, 200),
    attachments: normalizeAttachments(m.materials ?? []),
    updated: m.updateTime ?? m.creationTime ?? null,
    link: m.alternateLink ?? null,
  })).filter((m) => m.id);

  const announcements: AnnouncementSummary[] = announcementsRes.map((a) => ({
    id: a.id ?? "",
    text: trimText(a.text, 140),
    attachments: normalizeAttachments(a.materials ?? []),
    updated: a.updateTime ?? a.creationTime ?? null,
    link: a.alternateLink ?? null,
  })).filter((a) => a.id);

  const totals = {
    openWork: openWork.length,
    missing: missing.length,
    materials: materials.length,
    announcements: announcements.length,
  };
  const truncatedMaterials = materials.length > COURSE_DETAIL_CAP;
  const truncatedAnnouncements = announcements.length > COURSE_DETAIL_CAP;
  return {
    courseId: info.id,
    course: info.name,
    section: info.section,
    state: info.state,
    totals,
    openWork,
    missing,
    materials: materials.slice(0, COURSE_DETAIL_CAP),
    announcements: announcements.slice(0, COURSE_DETAIL_CAP),
    topics,
    topicsStatus,
    truncated: truncatedMaterials || truncatedAnnouncements,
    hint: truncatedMaterials || truncatedAnnouncements
      ? `Showing the ${COURSE_DETAIL_CAP} most recent of ${truncatedMaterials ? totals.materials : 0} materials / ${truncatedAnnouncements ? totals.announcements : 0} announcements. Use search to reach older items.`
      : null,
    errors,
  };
}

function matchesTokens(haystack: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const lower = haystack.toLowerCase();
  return tokens.every((token) => lower.includes(token));
}

function makeSnippet(body: string | null | undefined, tokens: string[]): string | null {
  const collapsed = (body ?? "").trim().replace(/\s+/g, " ");
  if (!collapsed) return null;
  const lower = collapsed.toLowerCase();
  let index = -1;
  for (const token of tokens) {
    const at = lower.indexOf(token);
    if (at !== -1 && (index === -1 || at < index)) index = at;
  }
  if (index === -1) return null;
  return trimText(collapsed.slice(Math.max(0, index - 60), index + 80), 140);
}

export async function searchEverything(services: GoogleServices, opts: SearchOptions, nowMillis = Date.now()): Promise<SearchResult> {
  const kinds = new Set(opts.kinds ?? ["assignment", "material", "announcement"]);
  const limit = opts.limit ?? 10;
  const detail = opts.detail ?? "concise";
  const tokens = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
  const errors: PartialError[] = [];

  let courses: CourseRow[];
  let skippedArchived = 0;
  if (opts.courseId) {
    const all = await listCourses(services, { includeArchived: true });
    courses = all.filter((c) => c.id === opts.courseId);
    if (courses.length === 0) {
      return {
        query: opts.query, checkedCourses: 0, skippedArchived: 0, total: 0, returned: 0, truncated: false, hint: null,
        errors: [{ courseId: opts.courseId, course: null, message: `No course with id "${opts.courseId}".` }],
        hits: [],
      };
    }
  } else {
    const all = await listCourses(services, { includeArchived: true });
    courses = opts.includeArchived ? all : all.filter((c) => c.state === "ACTIVE");
    skippedArchived = all.length - courses.length;
  }

  const perCourse = await mapPool(courses, 5, async (course): Promise<SearchHit[]> => {
    try {
      const [work, materials, announcements, subs] = await Promise.all([
        withRetry(`courseWork.list ${course.id}`, () => services.classroom.courses.courseWork.list({
          courseId: course.id, courseWorkStates: ["PUBLISHED"], orderBy: "updateTime desc", pageSize: 100,
        })),
        withRetry(`courseWorkMaterials.list ${course.id}`, () => services.classroom.courses.courseWorkMaterials.list({ courseId: course.id, pageSize: 50 })),
        withRetry(`announcements.list ${course.id}`, () => services.classroom.courses.announcements.list({ courseId: course.id, pageSize: 50 })),
        withRetry(`studentSubmissions.list ${course.id}`, () => services.classroom.courses.courseWork.studentSubmissions.list({
          courseId: course.id, courseWorkId: "-", userId: "me", pageSize: 100,
        })),
      ]);
      const subByWork = new Map(
        (subs.data.studentSubmissions ?? []).map((s) => [s.courseWorkId ?? "", s]),
      );
      const hits: SearchHit[] = [];
      if (kinds.has("assignment")) {
        for (const w of work.data.courseWork ?? []) {
          if (!w.id) continue;
          const body = w.description ?? "";
          if (!matchesTokens(`${w.title ?? ""} ${body}`, tokens)) continue;
          const sub = subByWork.get(w.id);
          const dueMillis = dueToMillis(w.dueDate, w.dueTime);
          const hit: SearchHit = {
            kind: "assignment", course: course.name, courseId: course.id, id: w.id,
            title: trimText(w.title, 140),
            due: dueToDay(w.dueDate),
            daysLeft: dueMillis !== undefined ? daysUntil(dueMillis, nowMillis) : null,
            myState: sub?.state ?? "NEW",
            snippet: makeSnippet(body, tokens),
            updated: w.updateTime ?? w.creationTime ?? null,
            attachments: normalizeAttachments(w.materials ?? []),
          };
          if (detail === "detailed") hit.link = w.alternateLink ?? undefined;
          hits.push(hit);
        }
      }
      if (kinds.has("material")) {
        for (const m of materials.data.courseWorkMaterial ?? []) {
          if (!m.id) continue;
          const body = m.description ?? "";
          if (!matchesTokens(`${m.title ?? ""} ${body}`, tokens)) continue;
          const hit: SearchHit = {
            kind: "material", course: course.name, courseId: course.id, id: m.id,
            title: trimText(m.title, 140),
            due: null, daysLeft: null, myState: null,
            snippet: makeSnippet(body, tokens),
            updated: m.updateTime ?? m.creationTime ?? null,
            attachments: normalizeAttachments(m.materials ?? []),
          };
          if (detail === "detailed") hit.link = m.alternateLink ?? undefined;
          hits.push(hit);
        }
      }
      if (kinds.has("announcement")) {
        for (const a of announcements.data.announcements ?? []) {
          if (!a.id) continue;
          const body = a.text ?? "";
          if (!matchesTokens(body, tokens)) continue;
          const hit: SearchHit = {
            kind: "announcement", course: course.name, courseId: course.id, id: a.id,
            title: trimText(a.text, 140),
            due: null, daysLeft: null, myState: null,
            snippet: makeSnippet(body, tokens),
            updated: a.updateTime ?? a.creationTime ?? null,
            attachments: normalizeAttachments(a.materials ?? []),
          };
          if (detail === "detailed") hit.link = a.alternateLink ?? undefined;
          hits.push(hit);
        }
      }
      return hits;
    } catch (error) {
      errors.push({ courseId: course.id, course: course.name, message: errorMessage(error) });
      return [];
    }
  });

  const all = perCourse.flat().sort((a, b) => (Date.parse(b.updated ?? "") || 0) - (Date.parse(a.updated ?? "") || 0));
  const total = all.length;
  const hits = all.slice(0, limit);
  const truncated = total > hits.length;
  return {
    query: opts.query,
    checkedCourses: courses.length,
    skippedArchived,
    total,
    returned: hits.length,
    truncated,
    hint: truncated ? `Showing ${hits.length} of ${total}. Add a course filter or more specific keywords.` : null,
    errors,
    hits,
  };
}
