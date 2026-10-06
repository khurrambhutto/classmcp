import type { classroom_v1 } from "googleapis";
import type { GoogleServices } from "./google.js";
import { withRetry } from "./google.js";
import { scanAll, CancelledError, type ScanOptions, type ScanResult } from "./pagination.js";
import { mapPool } from "./util.js";
import type {
  AnnouncementDetail, AnnouncementSummary, Attachment, AssignmentDetail, CourseDetail,
  CourseRow, MaterialDetail, MaterialSummary, NewRow, OverviewResult,
  PartialError, RubricCriterion, SearchHit, SearchResult, WorkRow,
} from "./schemas.js";

type HistoryEntry = NonNullable<AssignmentDetail["history"]>[number];

export type OverviewOptions = { view?: "due" | "missing" | "new" | "grades" | "courses"; window?: number; limit?: number; query?: string | undefined; includeArchived?: boolean; detail?: "concise" | "detailed"; signal?: AbortSignal | undefined };
export type SearchOptions = { query: string; courseId?: string | undefined; kinds?: Array<"assignment" | "material" | "announcement">; includeArchived?: boolean; limit?: number; detail?: "concise" | "detailed"; signal?: AbortSignal | undefined };

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

// --- Paginated list helpers -------------------------------------------------
// Every helper scans until the API runs out of pages or a safety budget stops
// it, and reports `truncated` rather than silently dropping later pages.

const COURSE_CACHE_TTL_MS = 45_000;
const courseCaches = new WeakMap<GoogleServices, { at: number; scan: ScanResult<CourseRow> }>();
const courseInflights = new WeakMap<GoogleServices, Promise<ScanResult<CourseRow>>>();

async function scanCourses(services: GoogleServices): Promise<ScanResult<CourseRow>> {
  const scan = await scanAll<CourseRow>(async (pageToken) => {
    const response = await withRetry("courses.list", () => services.classroom.courses.list({
      studentId: "me",
      courseStates: ["ACTIVE", "ARCHIVED"],
      pageSize: 100,
      pageToken,
    }));
    return {
      items: (response.data.courses ?? []).flatMap((c) => (c.id
        ? [{ id: c.id, name: c.name ?? "Unnamed", section: c.section ?? null, state: c.courseState ?? null }]
        : [])),
      nextPageToken: response.data.nextPageToken,
    };
  }, { maxPages: 20, maxItems: 500 });
  scan.items.sort(compareCourses);
  return scan;
}

export async function listCourses(services: GoogleServices, opts: { includeArchived?: boolean; signal?: AbortSignal | undefined } = {}): Promise<ScanResult<CourseRow>> {
  const includeArchived = opts.includeArchived ?? true;
  if (!includeArchived) {
    // The ACTIVE-only view is uncommon (search without includeArchived) and is
    // derived from the same index, so cache only the full list.
    const full = await listCourses(services, { includeArchived: true, signal: opts.signal });
    return { ...full, items: full.items.filter((c) => c.state === "ACTIVE") };
  }
  if (courseCaches.get(services) && Date.now() - (courseCaches.get(services) as { at: number }).at < COURSE_CACHE_TTL_MS) {
    return (courseCaches.get(services) as { scan: ScanResult<CourseRow> }).scan;
  }
  let inflight = courseInflights.get(services);
  if (!inflight) {
    inflight = scanCourses(services)
      .then((scan) => {
        courseCaches.set(services, { at: Date.now(), scan });
        return scan;
      })
      .finally(() => { courseInflights.delete(services); });
    courseInflights.set(services, inflight);
  }
  return inflight;
}

function compareCourses(a: CourseRow, b: CourseRow): number {
  const rank = (row: CourseRow) => (row.state === "ACTIVE" ? 0 : 1);
  return rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

const WORK_SCAN: ScanOptions = { maxPages: 10, maxItems: 1000 };

export async function listCourseWork(
  services: GoogleServices,
  courseId: string,
  opts: ScanOptions & { orderBy?: string } = {},
): Promise<ScanResult<classroom_v1.Schema$CourseWork>> {
  return scanAll(async (pageToken) => {
    const response = await withRetry(`courseWork.list ${courseId}`, () => services.classroom.courses.courseWork.list({
      courseId, courseWorkStates: ["PUBLISHED"], orderBy: opts.orderBy ?? "dueDate asc", pageSize: 100, pageToken,
    }));
    return { items: response.data.courseWork ?? [], nextPageToken: response.data.nextPageToken };
  }, opts);
}

export async function listSubmissions(
  services: GoogleServices,
  courseId: string,
  opts: ScanOptions = {},
): Promise<ScanResult<classroom_v1.Schema$StudentSubmission>> {
  return scanAll(async (pageToken) => {
    const response = await withRetry(`submissions.list ${courseId}`, () => services.classroom.courses.courseWork.studentSubmissions.list({
      courseId, courseWorkId: "-", userId: "me", pageSize: 100, pageToken,
    }));
    return { items: response.data.studentSubmissions ?? [], nextPageToken: response.data.nextPageToken };
  }, opts);
}

export async function listMaterials(
  services: GoogleServices,
  courseId: string,
  opts: ScanOptions = {},
): Promise<ScanResult<classroom_v1.Schema$CourseWorkMaterial>> {
  return scanAll(async (pageToken) => {
    const response = await withRetry(`courseWorkMaterials.list ${courseId}`, () => services.classroom.courses.courseWorkMaterials.list({
      courseId, pageSize: 100, pageToken,
    }));
    return { items: response.data.courseWorkMaterial ?? [], nextPageToken: response.data.nextPageToken };
  }, opts);
}

export async function listAnnouncements(
  services: GoogleServices,
  courseId: string,
  opts: ScanOptions = {},
): Promise<ScanResult<classroom_v1.Schema$Announcement>> {
  return scanAll(async (pageToken) => {
    const response = await withRetry(`announcements.list ${courseId}`, () => services.classroom.courses.announcements.list({
      courseId, pageSize: 100, pageToken,
    }));
    return { items: response.data.announcements ?? [], nextPageToken: response.data.nextPageToken };
  }, opts);
}

export async function listTopics(
  services: GoogleServices,
  courseId: string,
  opts: ScanOptions = {},
): Promise<ScanResult<classroom_v1.Schema$Topic>> {
  return scanAll(async (pageToken) => {
    const response = await withRetry(`topics.list ${courseId}`, () => services.classroom.courses.topics.list({
      courseId, pageSize: 100, pageToken,
    }));
    return { items: response.data.topic ?? [], nextPageToken: response.data.nextPageToken };
  }, opts);
}

// --- Partial-failure settlement ---------------------------------------------

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function wrapOverview(
  view: OverviewResult["view"],
  window: number,
  checkedCourses: number,
  skippedArchived: number,
  total: number,
  items: Array<WorkRow | NewRow | CourseRow>,
  errors: PartialError[],
  scanTruncated: boolean,
  steer?: string,
): OverviewResult {
  const returned = items.length;
  const truncated = total > returned;
  const parts: string[] = [];
  if (truncated) parts.push(`Showing ${returned} of ${total}. Narrow with a smaller window, query="...", or a different view.`);
  if (steer) parts.push(steer);
  return {
    view, window, checkedCourses, skippedArchived, total, returned, truncated,
    scanTruncated,
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
  const signal = opts.signal;
  const errors: PartialError[] = [];

  const courseScan = await listCourses(services, { includeArchived: true, signal });
  let scanTruncated = courseScan.truncated;
  // view=courses is an index and always lists archived courses; every other
  // view defaults to ACTIVE unless the caller opts in.
  const includeArchived = Boolean(opts.includeArchived) || view === "courses";
  const courses = includeArchived ? courseScan.items : courseScan.items.filter((c) => c.state === "ACTIVE");
  const skippedArchived = courseScan.items.length - courses.length;

  if (view === "courses") {
    const matched = query ? courses.filter((c) => c.name.toLowerCase().includes(query)) : courses;
    return wrapOverview(view, window, courses.length, 0, matched.length, matched.slice(0, limit), errors, scanTruncated);
  }

  if (view === "new") {
    const since = nowMillis - window * 86_400_000;
    const failedCourses = new Set<string>();
    const perCourse = await mapPool(courses, 5, async (course): Promise<NewRow[]> => {
      if (signal?.aborted) throw new CancelledError();
      const rows: NewRow[] = [];
      const push = (type: NewRow["type"], id: string | null | undefined, title: string | null | undefined, updated: string | null | undefined) => {
        if (!id || !updated || Date.parse(updated) < since) return;
        rows.push({ type, course: course.name, courseId: course.id, id, title: trimText(title, 140), updated });
      };
      const [work, materials, announcements] = await Promise.all([
        settle(() => listCourseWork(services, course.id, { orderBy: "updateTime desc", maxItems: 200, signal })),
        settle(() => listMaterials(services, course.id, { maxItems: 100, signal })),
        settle(() => listAnnouncements(services, course.id, { maxItems: 100, signal })),
      ]);
      const note = (operation: string) => (error: unknown) => errors.push({ courseId: course.id, course: course.name, operation, message: errorMessage(error) });
      if (work.ok) { scanTruncated ||= work.value.truncated; for (const w of work.value.items) push("assignment", w.id, w.title, w.updateTime ?? w.creationTime); }
      else note("courseWork.list")(work.error);
      if (materials.ok) { scanTruncated ||= materials.value.truncated; for (const m of materials.value.items) push("material", m.id, m.title, m.updateTime ?? m.creationTime); }
      else note("courseWorkMaterials.list")(materials.error);
      if (announcements.ok) { scanTruncated ||= announcements.value.truncated; for (const a of announcements.value.items) push("announcement", a.id, a.text, a.updateTime ?? a.creationTime); }
      else note("announcements.list")(announcements.error);
      if (!work.ok && !materials.ok && !announcements.ok) failedCourses.add(course.id);
      return rows;
    });
    const all = perCourse.flat().sort((a, b) => (Date.parse(b.updated ?? "") || 0) - (Date.parse(a.updated ?? "") || 0));
    const matched = query ? all.filter((r) => r.title.toLowerCase().includes(query) || r.course.toLowerCase().includes(query)) : all;
    if (courses.length > 0 && matched.length === 0 && failedCourses.size >= courses.length) throw new Error(errors[0].message);
    return wrapOverview(view, window, courses.length, skippedArchived, matched.length, matched.slice(0, limit), errors, scanTruncated);
  }

  let missingCount = 0;
  const failedCourses = new Set<string>();
  const perCourse = await mapPool(courses, 5, async (course): Promise<WorkRow[]> => {
    if (signal?.aborted) throw new CancelledError();
    const [work, subs] = await Promise.all([
      settle(() => listCourseWork(services, course.id, { ...WORK_SCAN, signal })),
      settle(() => listSubmissions(services, course.id, { ...WORK_SCAN, signal })),
    ]);
    if (!work.ok) {
      errors.push({ courseId: course.id, course: course.name, operation: "courseWork.list", message: errorMessage(work.error) });
      failedCourses.add(course.id);
      return [];
    }
    if (!subs.ok) {
      errors.push({ courseId: course.id, course: course.name, operation: "submissions.list", message: errorMessage(subs.error) });
      failedCourses.add(course.id);
      return [];
    }
    scanTruncated ||= work.value.truncated || subs.value.truncated;
    const rows = buildWorkRows(course, work.value.items, subs.value.items, view, window, nowMillis, detail);
    if (view === "due") {
      missingCount += buildWorkRows(course, work.value.items, subs.value.items, "missing", window, nowMillis, detail).length;
    }
    return rows;
  });
  const all = perCourse.flat().sort(workComparator(view));
  const matched = query ? all.filter((r) => r.title.toLowerCase().includes(query) || r.course.toLowerCase().includes(query)) : all;
  if (courses.length > 0 && matched.length === 0 && failedCourses.size >= courses.length) throw new Error(errors[0].message);
  const steer = view === "due" && missingCount > 0
    ? `${missingCount} overdue/late item(s) are in view=missing.`
    : undefined;
  return wrapOverview(view, window, courses.length, skippedArchived, matched.length, matched.slice(0, limit), errors, scanTruncated, steer);
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

export async function getCourseDetail(services: GoogleServices, courseId: string, nowMillis = Date.now(), signal?: AbortSignal): Promise<CourseDetail> {
  const courseScan = await listCourses(services, { includeArchived: true, signal });
  const info = courseScan.items.find((c) => c.id === courseId);
  if (!info) throw new Error(`No course with id "${courseId}".`);
  const errors: PartialError[] = [];
  let scanTruncated = courseScan.truncated;
  const pushError = (operation: string) => (error: unknown) =>
    errors.push({ courseId, course: info.name, operation, message: errorMessage(error) });

  const [workSubs, materialsRes, announcementsRes, topicsRes] = await Promise.all([
    (async () => {
      const [work, subs] = await Promise.all([
        settle(() => listCourseWork(services, courseId, { ...WORK_SCAN, signal })),
        settle(() => listSubmissions(services, courseId, { ...WORK_SCAN, signal })),
      ]);
      if (!work.ok) { pushError("courseWork.list")(work.error); return { work: [], subs: [] }; }
      scanTruncated ||= work.value.truncated;
      if (!subs.ok) { pushError("submissions.list")(subs.error); return { work: work.value.items, subs: [] }; }
      scanTruncated ||= subs.value.truncated;
      return { work: work.value.items, subs: subs.value.items };
    })(),
    (async () => {
      const result = await settle(() => listMaterials(services, courseId, { maxPages: 5, maxItems: 500, signal }));
      if (!result.ok) { pushError("courseWorkMaterials.list")(result.error); return []; }
      scanTruncated ||= result.value.truncated;
      return result.value.items;
    })(),
    (async () => {
      const result = await settle(() => listAnnouncements(services, courseId, { maxPages: 5, maxItems: 500, signal }));
      if (!result.ok) { pushError("announcements.list")(result.error); return []; }
      scanTruncated ||= result.value.truncated;
      return result.value.items;
    })(),
    (async () => {
      const result = await settle(() => listTopics(services, courseId, { maxPages: 5, maxItems: 500, signal }));
      if (!result.ok) return { status: (isDenied(result.error) ? "denied" : "error") as CourseDetail["topicsStatus"], rows: null as CourseDetail["topics"] };
      scanTruncated ||= result.value.truncated;
      const rows = result.value.items
        .filter((t): t is classroom_v1.Schema$Topic & { topicId: string } => Boolean(t?.topicId))
        .map((t) => ({ id: t.topicId, name: t.name ?? "Unnamed" }));
      return { status: (rows.length > 0 ? "present" : "none") as CourseDetail["topicsStatus"], rows };
    })(),
  ]);

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
    topics: topicsRes.rows,
    topicsStatus: topicsRes.status,
    truncated: truncatedMaterials || truncatedAnnouncements,
    scanTruncated,
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
  const wantsAssignments = kinds.has("assignment");

  const courseScan = await listCourses(services, { includeArchived: true, signal: opts.signal });
  let scanTruncated = courseScan.truncated;
  let courses: CourseRow[];
  let skippedArchived = 0;
  if (opts.courseId) {
    courses = courseScan.items.filter((c) => c.id === opts.courseId);
    if (courses.length === 0) {
      return {
        query: opts.query, checkedCourses: 0, skippedArchived: 0, total: 0, returned: 0, truncated: false,
        scanTruncated, hint: null,
        errors: [{ courseId: opts.courseId, course: null, message: `No course with id "${opts.courseId}".` }],
        hits: [],
      };
    }
  } else {
    courses = opts.includeArchived ? courseScan.items : courseScan.items.filter((c) => c.state === "ACTIVE");
    skippedArchived = courseScan.items.length - courses.length;
  }

  const failedCourses = new Set<string>();
  const perCourse = await mapPool(courses, 5, async (course): Promise<SearchHit[]> => {
    if (opts.signal?.aborted) throw new CancelledError();
    const hits: SearchHit[] = [];
    let kindsOk = 0;
    let kindsFailed = 0;
    const note = (operation: string) => (error: unknown) => {
      kindsFailed++;
      errors.push({ courseId: course.id, course: course.name, operation, message: errorMessage(error) });
    };

    // Only fetch the endpoints the requested kinds actually need.
    const [work, subs, materials, announcements] = await Promise.all([
      wantsAssignments ? settle(() => listCourseWork(services, course.id, { orderBy: "updateTime desc", ...WORK_SCAN, signal: opts.signal })) : undefined,
      wantsAssignments ? settle(() => listSubmissions(services, course.id, { ...WORK_SCAN, signal: opts.signal })) : undefined,
      kinds.has("material") ? settle(() => listMaterials(services, course.id, { maxPages: 5, maxItems: 500, signal: opts.signal })) : undefined,
      kinds.has("announcement") ? settle(() => listAnnouncements(services, course.id, { maxPages: 5, maxItems: 500, signal: opts.signal })) : undefined,
    ]);

    if (wantsAssignments) {
      if (!work || !work.ok) { if (work) note("courseWork.list")(work.error); }
      else {
        kindsOk++;
        scanTruncated ||= work.value.truncated;
        const subByWork = new Map<string, classroom_v1.Schema$StudentSubmission>();
        if (subs && subs.ok) {
          scanTruncated ||= subs.value.truncated;
          for (const s of subs.value.items) subByWork.set(s.courseWorkId ?? "", s);
        } else if (subs) {
          note("submissions.list")(subs.error);
        }
        for (const w of work.value.items) {
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
            myState: sub?.state ?? null,
            snippet: makeSnippet(body, tokens),
            updated: w.updateTime ?? w.creationTime ?? null,
            attachments: normalizeAttachments(w.materials ?? []),
          };
          if (detail === "detailed") hit.link = w.alternateLink ?? undefined;
          hits.push(hit);
        }
      }
    }
    if (kinds.has("material")) {
      if (!materials || !materials.ok) { if (materials) note("courseWorkMaterials.list")(materials.error); }
      else {
        kindsOk++;
        scanTruncated ||= materials.value.truncated;
        for (const m of materials.value.items) {
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
    }
    if (kinds.has("announcement")) {
      if (!announcements || !announcements.ok) { if (announcements) note("announcements.list")(announcements.error); }
      else {
        kindsOk++;
        scanTruncated ||= announcements.value.truncated;
        for (const a of announcements.value.items) {
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
    }
    if (kindsOk === 0 && kindsFailed > 0) failedCourses.add(course.id);
    return hits;
  });

  const all = perCourse.flat().sort((a, b) => (Date.parse(b.updated ?? "") || 0) - (Date.parse(a.updated ?? "") || 0));
  if (courses.length > 0 && all.length === 0 && failedCourses.size >= courses.length) throw new Error(errors[0].message);
  const total = all.length;
  const hits = all.slice(0, limit);
  const truncated = total > hits.length;
  const hintParts: string[] = [];
  if (truncated) hintParts.push(`Showing ${hits.length} of ${total}. Add a course filter or more specific keywords.`);
  if (scanTruncated) hintParts.push("Some lists were longer than the internal scan budget; results may omit very old items (recent items are scanned first for assignments).");
  return {
    query: opts.query,
    checkedCourses: courses.length,
    skippedArchived,
    total,
    returned: hits.length,
    truncated,
    scanTruncated,
    hint: hintParts.length > 0 ? hintParts.join(" ") : null,
    errors,
    hits,
  };
}
