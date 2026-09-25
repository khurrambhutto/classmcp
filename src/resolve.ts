import type { GoogleServices } from "./google.js";
import { withRetry } from "./google.js";
import { listCourses } from "./digest.js";

export type CourseRef = { courseId?: string | undefined; course?: string | undefined };
export type AssignmentRef = { assignmentId?: string | undefined; assignment?: string | undefined };
export type CourseInfo = { id: string; name: string; section: string | null; state: string | null };
export type WorkInfo = { id: string; courseId: string; title: string; workType: string | null };
export type Resolution<T> = { ok: true; item: T } | { ok: false; message: string };

const KNOWN_LIMIT = 10;

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function nameList(items: Array<{ id: string; name: string }>): string {
  return items.slice(0, KNOWN_LIMIT).map((item) => `${item.name} (${item.id})`).join(", ") || "none";
}

function scoreMatch(candidate: string, query: string, queryTokens: string[]): number {
  if (candidate === query) return 3;
  if (candidate.includes(query) || query.includes(candidate)) return 2;
  const nameTokens = new Set(candidate.split(" "));
  if (queryTokens.some((token) => nameTokens.has(token))) return 1;
  return 0;
}

export function pickOne<T extends { id: string; name: string }>(items: T[], ref: { id?: string | undefined; name?: string | undefined }, kindLabel: string): Resolution<T> {
  const id = ref.id?.trim();
  const name = ref.name?.trim();
  if (id) {
    const match = items.find((item) => item.id === id);
    if (!match) return { ok: false, message: `No ${kindLabel} with id "${id}".` };
    return { ok: true, item: match };
  }
  if (!name) return { ok: false, message: `Provide ${kindLabel} id or name.` };
  const query = normalize(name);
  const queryTokens = query.split(" ").filter((token) => token.length >= 3);
  const scored = items
    .map((item) => ({ item, score: scoreMatch(normalize(item.name), query, queryTokens) }))
    .filter((entry) => entry.score > 0);
  const best = Math.max(0, ...scored.map((entry) => entry.score));
  const top = scored.filter((entry) => entry.score === best);
  if (top.length === 0) return { ok: false, message: `No ${kindLabel} matches "${name}". Known: ${nameList(items)}.` };
  if (top.length > 1) {
    const ties = top.slice(0, KNOWN_LIMIT).map((entry) => `${entry.item.name} (${entry.item.id})`).join(", ");
    return { ok: false, message: `Multiple ${kindLabel}s match "${name}": ${ties}. Pass the ${kindLabel}Id parameter.` };
  }
  return { ok: true, item: top[0].item };
}

export async function resolveCourse(services: GoogleServices, ref: CourseRef): Promise<Resolution<CourseInfo>> {
  const courses = await listCourses(services, { includeArchived: true });
  return pickOne(courses, { id: ref.courseId, name: ref.course }, "course");
}

export async function resolveAssignment(services: GoogleServices, courseId: string, ref: AssignmentRef): Promise<Resolution<WorkInfo>> {
  const items: Array<{ id: string; name: string; workType: string | null }> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 3; page++) {
    const response = await withRetry(`courseWork.list ${courseId}`, () => services.classroom.courses.courseWork.list({
      courseId,
      courseWorkStates: ["PUBLISHED"],
      orderBy: "updateTime desc",
      pageSize: 100,
      pageToken,
    }));
    for (const w of response.data.courseWork ?? []) {
      if (w.id) items.push({ id: w.id, name: w.title ?? "Untitled", workType: w.workType ?? null });
    }
    pageToken = response.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  const found = pickOne(items, { id: ref.assignmentId, name: ref.assignment }, "assignment");
  if (!found.ok) return found;
  return { ok: true, item: { id: found.item.id, courseId, title: found.item.name, workType: found.item.workType } };
}
