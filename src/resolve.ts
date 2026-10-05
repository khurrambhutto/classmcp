import type { GoogleServices } from "./google.js";
import { withRetry } from "./google.js";
import { listCourses, listCourseWork, listMaterials, listAnnouncements } from "./digest.js";

export type CourseRef = { courseId?: string | undefined; course?: string | undefined };
export type AssignmentRef = { assignmentId?: string | undefined; assignment?: string | undefined };
export type MaterialRef = { materialId?: string | undefined; material?: string | undefined };
export type AnnouncementRef = { announcementId?: string | undefined; announcement?: string | undefined };
export type CourseInfo = { id: string; name: string; section: string | null; state: string | null };
export type WorkInfo = { id: string; courseId: string; title: string; workType: string | null };
export type MaterialInfo = { id: string; courseId: string; title: string };
export type AnnouncementInfo = { id: string; courseId: string; title: string };
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

function withScanLimitHint(message: string, kindLabel: string, truncated: boolean): string {
  return truncated ? `${message} (The ${kindLabel} list hit the internal scan limit; pass the exact ${kindLabel} id.)` : message;
}

/**
 * Resolution for an exact id: validate with one GET instead of listing every
 * course. Fuzzy names still fall back to a paginated scan.
 */
export async function resolveCourse(services: GoogleServices, ref: CourseRef): Promise<Resolution<CourseInfo>> {
  const id = ref.courseId?.trim();
  if (id && !ref.course?.trim()) {
    try {
      const response = await withRetry(`courses.get ${id}`, () => services.classroom.courses.get({ id }));
      const course = response.data;
      if (!course.id) throw new Error("not found");
      return {
        ok: true,
        item: { id: course.id, name: course.name ?? "Unnamed", section: course.section ?? null, state: course.courseState ?? null },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `No course with id "${id}" (${detail}).` };
    }
  }
  const scan = await listCourses(services, { includeArchived: true });
  const found = pickOne(scan.items, { id, name: ref.course }, "course");
  if (!found.ok) return { ok: false, message: withScanLimitHint(found.message, "course", scan.truncated) };
  return found;
}

export async function resolveAssignment(services: GoogleServices, courseId: string, ref: AssignmentRef): Promise<Resolution<WorkInfo>> {
  const id = ref.assignmentId?.trim();
  if (id && !ref.assignment?.trim()) {
    // One GET later validates existence and supplies the real title.
    return { ok: true, item: { id, courseId, title: "", workType: null } };
  }
  const scan = await listCourseWork(services, courseId, { orderBy: "updateTime desc" });
  const items = scan.items
    .filter((w): w is typeof w & { id: string } => Boolean(w.id))
    .map((w) => ({ id: w.id, name: w.title ?? "Untitled", workType: w.workType ?? null }));
  const found = pickOne(items, { id, name: ref.assignment }, "assignment");
  if (!found.ok) return { ok: false, message: withScanLimitHint(found.message, "assignment", scan.truncated) };
  return { ok: true, item: { id: found.item.id, courseId, title: found.item.name, workType: found.item.workType } };
}

export async function resolveMaterial(services: GoogleServices, courseId: string, ref: MaterialRef): Promise<Resolution<MaterialInfo>> {
  const id = ref.materialId?.trim();
  if (id && !ref.material?.trim()) {
    return { ok: true, item: { id, courseId, title: "" } };
  }
  const scan = await listMaterials(services, courseId);
  const items = scan.items
    .filter((m): m is typeof m & { id: string } => Boolean(m.id))
    .map((m) => ({ id: m.id, name: m.title ?? "Untitled" }));
  const found = pickOne(items, { id, name: ref.material }, "material");
  if (!found.ok) return { ok: false, message: withScanLimitHint(found.message, "material", scan.truncated) };
  return { ok: true, item: { id: found.item.id, courseId, title: found.item.name } };
}

export async function resolveAnnouncement(services: GoogleServices, courseId: string, ref: AnnouncementRef): Promise<Resolution<AnnouncementInfo>> {
  const id = ref.announcementId?.trim();
  if (id && !ref.announcement?.trim()) {
    return { ok: true, item: { id, courseId, title: "" } };
  }
  const scan = await listAnnouncements(services, courseId);
  const items = scan.items
    .filter((a): a is typeof a & { id: string } => Boolean(a.id))
    .map((a) => ({ id: a.id, name: (a.text ?? "Untitled").slice(0, 200) }));
  const found = pickOne(items, { id, name: ref.announcement }, "announcement");
  if (!found.ok) return { ok: false, message: withScanLimitHint(found.message, "announcement", scan.truncated) };
  return { ok: true, item: { id: found.item.id, courseId, title: found.item.name } };
}
