import type { classroom_v1 } from "googleapis";
import type { GoogleServices } from "./google.js";

export type DueItem = {
  course: string;
  courseId: string;
  id: string;
  title: string;
  due: string;
  daysLeft: number;
  myState: string;
  late: boolean;
  points: number | null;
};

export type StatusItem = {
  courseId: string;
  id: string;
  title: string;
  state: string | null;
  workType: string | null;
  due: string | null;
  points: number | null;
  myState: string;
  late: boolean;
  grade: number | null;
  materials: string[];
  description: string;
  link: string | null;
};

export type NewsItem = {
  type: "assignment" | "material" | "announcement";
  course: string;
  courseId: string;
  id: string;
  title: string;
  updated: string | null;
};

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

export function summarizeMaterial(m: classroom_v1.Schema$Material): string {
  const drive = m.driveFile as { driveFile?: { title?: string | null } } | undefined;
  if (drive?.driveFile?.title) return `drive:${drive.driveFile.title}`;
  if (m.form) return `form:${(m.form as { title?: string | null }).title ?? "form"}`;
  if (m.link) return `link:${(m.link as { url?: string | null }).url ?? ""}`;
  if (m.youtubeVideo) return `video:${(m.youtubeVideo as { title?: string | null }).title ?? "youtube"}`;
  return "file:attachment";
}

const DONE_STATES = new Set(["TURNED_IN", "RETURNED"]);

async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

export async function listActiveCourses(services: GoogleServices): Promise<{ id: string; name: string }[]> {
  const courses: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  do {
    const response = await services.classroom.courses.list({
      studentId: "me",
      courseStates: ["ACTIVE"],
      pageSize: 100,
      pageToken,
    });
    for (const c of response.data.courses ?? []) {
      if (c.id) courses.push({ id: c.id, name: c.name ?? "Unnamed" });
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  return courses;
}

export async function getWhatsDue(
  services: GoogleServices,
  opts: { daysAhead?: number; limit?: number; includeNoDueDate?: boolean; includeTurnedIn?: boolean } = {},
  nowMillis = Date.now(),
): Promise<{ checkedCourses: number; openCount: number; items: DueItem[] }> {
  const daysAhead = opts.daysAhead ?? 14;
  const limit = opts.limit ?? 50;
  const courses = await listActiveCourses(services);
  const cutoff = nowMillis + daysAhead * 86_400_000;

  const perCourse = await mapPool(courses, 5, async (course) => {
    const [work, subs] = await Promise.all([
      services.classroom.courses.courseWork.list({
        courseId: course.id,
        courseWorkStates: ["PUBLISHED"],
        orderBy: "dueDate asc",
        pageSize: 100,
      }),
      services.classroom.courses.courseWork.studentSubmissions.list({
        courseId: course.id,
        courseWorkId: "-",
        userId: "me",
        pageSize: 100,
      }),
    ]);
    const subByWork = new Map(
      (subs.data.studentSubmissions ?? []).map((s) => [s.courseWorkId ?? "", s]),
    );
    const rows: DueItem[] = [];
    for (const w of work.data.courseWork ?? []) {
      if (!w.id) continue;
      const sub = subByWork.get(w.id);
      const myState = sub?.state ?? "NEW";
      if (!opts.includeTurnedIn && DONE_STATES.has(myState)) continue;
      const dueMillis = dueToMillis(w.dueDate, w.dueTime);
      if (dueMillis === undefined) {
        if (opts.includeNoDueDate) {
          rows.push({
            course: course.name, courseId: course.id, id: w.id,
            title: w.title ?? "Untitled", due: "no due date", daysLeft: 0,
            myState, late: sub?.late ?? false, points: w.maxPoints ?? null,
          });
        }
        continue;
      }
      if (dueMillis > cutoff) continue;
      rows.push({
        course: course.name, courseId: course.id, id: w.id,
        title: w.title ?? "Untitled", due: dueToDay(w.dueDate) ?? "no due date",
        daysLeft: daysUntil(dueMillis, nowMillis),
        myState, late: sub?.late ?? false, points: w.maxPoints ?? null,
      });
    }
    return rows;
  });

  const items = perCourse.flat().sort((a, b) => a.daysLeft - b.daysLeft).slice(0, limit);
  return { checkedCourses: courses.length, openCount: items.length, items };
}

export async function getAssignmentStatus(
  services: GoogleServices,
  courseId: string,
  assignmentId: string,
  maxDescChars = 300,
): Promise<StatusItem> {
  const [work, subs] = await Promise.all([
    services.classroom.courses.courseWork.get({ courseId, id: assignmentId }),
    services.classroom.courses.courseWork.studentSubmissions.list({
      courseId, courseWorkId: assignmentId, userId: "me", pageSize: 1,
    }),
  ]);
  const w = work.data;
  const sub = subs.data.studentSubmissions?.[0];
  return {
    courseId,
    id: assignmentId,
    title: w.title ?? "Untitled",
    state: w.state ?? null,
    workType: w.workType ?? null,
    due: dueToDay(w.dueDate),
    points: w.maxPoints ?? null,
    myState: sub?.state ?? "NEW",
    late: sub?.late ?? false,
    grade: sub?.assignedGrade ?? null,
    materials: (w.materials ?? []).map(summarizeMaterial),
    description: trimText(w.description, maxDescChars),
    link: w.alternateLink ?? null,
  };
}

export async function getWhatsNew(
  services: GoogleServices,
  opts: { sinceDays?: number; limit?: number } = {},
  nowMillis = Date.now(),
): Promise<{ since: string; count: number; items: NewsItem[] }> {
  const sinceDays = opts.sinceDays ?? 1;
  const limit = opts.limit ?? 30;
  const since = nowMillis - sinceDays * 86_400_000;
  const sinceIso = new Date(since).toISOString();
  const courses = await listActiveCourses(services);

  const perCourse = await mapPool(courses, 5, async (course) => {
    const [work, materials, announcements] = await Promise.all([
      services.classroom.courses.courseWork.list({
        courseId: course.id, courseWorkStates: ["PUBLISHED"],
        orderBy: "updateTime desc", pageSize: 20,
      }),
      services.classroom.courses.courseWorkMaterials.list({ courseId: course.id, pageSize: 20 }),
      services.classroom.courses.announcements.list({ courseId: course.id, pageSize: 20 }),
    ]);
    const rows: NewsItem[] = [];
    for (const w of work.data.courseWork ?? []) {
      const updated = w.updateTime ?? w.creationTime ?? null;
      if (!updated || Date.parse(updated) < since) continue;
      if (!w.id) continue;
      rows.push({
        type: "assignment", course: course.name, courseId: course.id, id: w.id,
        title: trimText(w.title, 140), updated,
      });
    }
    for (const m of materials.data.courseWorkMaterial ?? []) {
      const updated = m.updateTime ?? m.creationTime ?? null;
      if (!updated || Date.parse(updated) < since) continue;
      if (!m.id) continue;
      rows.push({
        type: "material", course: course.name, courseId: course.id, id: m.id,
        title: trimText(m.title, 140), updated,
      });
    }
    for (const a of announcements.data.announcements ?? []) {
      const updated = a.updateTime ?? a.creationTime ?? null;
      if (!updated || Date.parse(updated) < since) continue;
      if (!a.id) continue;
      rows.push({
        type: "announcement", course: course.name, courseId: course.id, id: a.id,
        title: trimText(a.text, 140), updated,
      });
    }
    return rows;
  });

  const items = perCourse
    .flat()
    .sort((a, b) => Date.parse(b.updated ?? "") - Date.parse(a.updated ?? ""))
    .slice(0, limit);
  return { since: sinceIso, count: items.length, items };
}
