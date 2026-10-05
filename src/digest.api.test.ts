import { describe, expect, it, vi } from "vitest";
import type { GoogleServices } from "./google.js";
import { getCourseDetail, getOverview, searchEverything } from "./digest.js";
import { resolveAssignment } from "./resolve.js";

type Row = Record<string, unknown>;

function datePlus(days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.now() + days * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function pagedList<T>(items: T[], key: string, pageSize: number, calls: string[], endpoint: string) {
  return vi.fn(async (params: { pageToken?: string } = {}) => {
    calls.push(endpoint);
    const start = params.pageToken ? Number(params.pageToken) : 0;
    const slice = items.slice(start, start + pageSize);
    const next = start + pageSize;
    return { data: { [key]: slice, nextPageToken: next < items.length ? String(next) : undefined } };
  });
}

function pagedFor<T>(
  key: string,
  itemsFor: (courseId: string) => T[],
  pageSize: number,
  calls: string[],
  endpoint: (courseId: string) => string,
  failWith?: Error,
) {
  return vi.fn(async (params: { courseId: string; pageToken?: string }) => {
    calls.push(endpoint(params.courseId));
    if (failWith) throw failWith;
    const items = itemsFor(params.courseId);
    const start = params.pageToken ? Number(params.pageToken) : 0;
    const slice = items.slice(start, start + pageSize);
    const next = start + pageSize;
    return { data: { [key]: slice, nextPageToken: next < items.length ? String(next) : undefined } };
  });
}

function fakeServices(opts: {
  courses: Row[];
  work?: Record<string, Row[]>;
  subs?: Record<string, Row[]>;
  materials?: Record<string, Row[]>;
  announcements?: Record<string, Row[]>;
  topics?: Record<string, Row[]>;
  fail?: Partial<Record<"courseWork" | "submissions" | "materials" | "announcements", Error>>;
  pageSize?: number;
}): { services: GoogleServices; calls: string[] } {
  const pageSize = opts.pageSize ?? 100;
  const calls: string[] = [];
  const work = opts.work ?? {};
  const subs = opts.subs ?? {};
  const materials = opts.materials ?? {};
  const announcements = opts.announcements ?? {};
  const topics = opts.topics ?? {};

  const services = {
    classroom: {
      courses: {
        list: pagedList(opts.courses, "courses", pageSize, calls, "courses.list"),
        get: vi.fn(async ({ id }: { id: string }) => {
          const found = opts.courses.find((c) => c.id === id);
          if (!found) throw new Error("Requested entity was not found.");
          return { data: found };
        }),
        courseWork: {
          list: pagedFor("courseWork", (courseId) => work[courseId] ?? [], pageSize, calls,
            (courseId) => `courseWork.list ${courseId}`, opts.fail?.courseWork),
          studentSubmissions: {
            list: pagedFor("studentSubmissions", (courseId) => subs[courseId] ?? [], pageSize, calls,
              (courseId) => `submissions.list ${courseId}`, opts.fail?.submissions),
          },
        },
        courseWorkMaterials: {
          list: pagedFor("courseWorkMaterial", (courseId) => materials[courseId] ?? [], pageSize, calls,
            (courseId) => `courseWorkMaterials.list ${courseId}`, opts.fail?.materials),
        },
        announcements: {
          list: pagedFor("announcements", (courseId) => announcements[courseId] ?? [], pageSize, calls,
            (courseId) => `announcements.list ${courseId}`, opts.fail?.announcements),
        },
        topics: {
          list: pagedFor("topic", (courseId) => topics[courseId] ?? [], pageSize, calls,
            (courseId) => `topics.list ${courseId}`),
        },
      },
    },
  } as unknown as GoogleServices;
  return { services, calls };
}

const COURSE = { id: "c1", name: "Physics", courseState: "ACTIVE" };

function workRow(id: string, overrides: Row = {}): Row {
  return { id, title: `Work ${id}`, state: "PUBLISHED", workType: "ASSIGNMENT", dueDate: datePlus(3), updateTime: new Date().toISOString(), ...overrides };
}

describe("pagination through the digest API", () => {
  it("getOverview includes coursework from every page", async () => {
    const work = Array.from({ length: 6 }, (_, i) => workRow(`w${i}`));
    const { services } = fakeServices({ courses: [COURSE], work: { c1: work }, pageSize: 2 });
    const result = await getOverview(services, { view: "due", limit: 50 });
    expect(result.items).toHaveLength(6);
    expect(result.total).toBe(6);
    expect(result.scanTruncated).toBe(false);
  });

  it("getOverview sees submission states from later pages", async () => {
    const work = [workRow("w1"), workRow("w2"), workRow("w3")];
    const subs = [
      { courseWorkId: "w1", state: "CREATED" },
      { courseWorkId: "w2", state: "TURNED_IN" },
      { courseWorkId: "w3", state: "CREATED" },
    ];
    const { services } = fakeServices({ courses: [COURSE], work: { c1: work }, subs: { c1: subs }, pageSize: 1 });
    const result = await getOverview(services, { view: "due", limit: 50 });
    const ids = result.items.map((item) => (item as { id: string }).id);
    expect(ids.sort()).toEqual(["w1", "w3"]);
  });

  it("getOverview reports scanTruncated when the safety budget cuts the scan", async () => {
    const work = Array.from({ length: 1001 }, (_, i) => workRow(`w${i}`, { dueDate: undefined }));
    const { services } = fakeServices({ courses: [COURSE], work: { c1: work }, pageSize: 500 });
    const result = await getOverview(services, { view: "due", limit: 50 });
    expect(result.scanTruncated).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(1000);
    expect(result.returned).toBe(50);
  });

  it("search returns materials and announcements from later pages", async () => {
    const materials = [
      { id: "m1", title: "Wave lab", description: "interference", updateTime: new Date().toISOString() },
      { id: "m2", title: "Wave notes", description: "diffraction", updateTime: new Date().toISOString() },
    ];
    const announcements = [
      { id: "a1", text: "wave exam on Friday", updateTime: new Date().toISOString() },
      { id: "a2", text: "unrelated", updateTime: new Date().toISOString() },
    ];
    const { services } = fakeServices({ courses: [COURSE], materials: { c1: materials }, announcements: { c1: announcements }, pageSize: 1 });
    const result = await searchEverything(services, { query: "wave", kinds: ["material", "announcement"], limit: 10 });
    expect(result.hits.map((h) => h.id).sort()).toEqual(["a1", "m1", "m2"]);
  });

  it("search with kinds=[material] does not call coursework or submissions", async () => {
    const { services, calls } = fakeServices({
      courses: [COURSE],
      materials: { c1: [{ id: "m1", title: "Wave lab", description: "waves", updateTime: new Date().toISOString() }] },
    });
    const result = await searchEverything(services, { query: "wave", kinds: ["material"] });
    expect(result.hits).toHaveLength(1);
    expect(calls.some((c) => c.startsWith("courseWork.list"))).toBe(false);
    expect(calls.some((c) => c.startsWith("submissions.list"))).toBe(false);
    expect(calls.some((c) => c.startsWith("announcements.list"))).toBe(false);
  });

  it("search keeps announcement hits when the materials endpoint fails", async () => {
    const { services } = fakeServices({
      courses: [COURSE],
      announcements: { c1: [{ id: "a1", text: "wave exam on Friday", updateTime: new Date().toISOString() }] },
      fail: { materials: new Error("materials boom") },
    });
    const result = await searchEverything(services, { query: "wave", kinds: ["material", "announcement"] });
    expect(result.hits.map((h) => h.id)).toEqual(["a1"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ operation: "courseWorkMaterials.list", message: "materials boom" });
  });

  it("search still returns hits from a healthy course when another course fails", async () => {
    const { services } = fakeServices({
      courses: [COURSE, { id: "c2", name: "Chemistry", courseState: "ACTIVE" }],
      work: { c2: [workRow("w9", { title: "Wave report" })] },
    });
    (services.classroom.courses.courseWork as unknown as { list: ReturnType<typeof vi.fn> }).list = vi.fn(async (params: { courseId: string }) => {
      if (params.courseId === "c1") throw new Error("courseWork boom");
      return { data: { courseWork: [workRow("w9", { title: "Wave report" })] } };
    });
    const result = await searchEverything(services, { query: "wave", kinds: ["assignment"] });
    expect(result.hits.map((h) => h.id)).toEqual(["w9"]);
    expect(result.errors[0]).toMatchObject({ courseId: "c1", operation: "courseWork.list" });
  });

  it("search throws only when every course failed", async () => {
    const { services } = fakeServices({ courses: [COURSE], fail: { courseWork: new Error("courseWork down"), submissions: new Error("subs down") } });
    await expect(searchEverything(services, { query: "wave", kinds: ["assignment"] })).rejects.toThrow("courseWork down");
  });

  it("resolves an exact assignment id without listing coursework", async () => {
    const { services, calls } = fakeServices({ courses: [COURSE] });
    const result = await resolveAssignment(services, "c1", { assignmentId: "w-page-two" });
    expect(result).toEqual({ ok: true, item: { id: "w-page-two", courseId: "c1", title: "", workType: null } });
    expect(calls.some((c) => c.startsWith("courseWork.list"))).toBe(false);
  });

  it("resolves an assignment name that only appears on a later page", async () => {
    const work = [workRow("w1", { title: "First" }), workRow("w2", { title: "Second" }), workRow("w3", { title: "Hidden treasure" })];
    const { services } = fakeServices({ courses: [COURSE], work: { c1: work }, pageSize: 2 });
    const result = await resolveAssignment(services, "c1", { assignment: "hidden treasure" });
    expect(result).toEqual({ ok: true, item: { id: "w3", courseId: "c1", title: "Hidden treasure", workType: "ASSIGNMENT" } });
  });

  it("getCourseDetail includes topics from every page", async () => {
    const topics = Array.from({ length: 5 }, (_, i) => ({ topicId: `t${i}`, name: `Topic ${i}` }));
    const materials = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, title: `Material ${i}`, updateTime: new Date().toISOString() }));
    const { services } = fakeServices({ courses: [COURSE], topics: { c1: topics }, materials: { c1: materials }, pageSize: 2 });
    const detail = await getCourseDetail(services, "c1");
    expect(detail.topicsStatus).toBe("present");
    expect(detail.topics).toHaveLength(5);
    expect(detail.totals.materials).toBe(5);
    expect(detail.materials).toHaveLength(5);
  });

  it("grades defaults to ACTIVE courses and includeArchived includes archived", async () => {
    const graded = (id: string, courseId: string) => ({ id, courseWorkId: id, courseId, state: "TURNED_IN", assignedGrade: 10 });
    const courses = [COURSE, { id: "c2", name: "Old Chem", courseState: "ARCHIVED" }];
    const work = { c1: [workRow("w1")], c2: [workRow("w2", { dueDate: undefined })] };
    const subs = { c1: [graded("w1", "c1")], c2: [graded("w2", "c2")] };
    const { services } = fakeServices({ courses, work, subs });
    const active = await getOverview(services, { view: "grades" });
    expect(active.items.map((item) => (item as { id: string }).id)).toEqual(["w1"]);
    expect(active.skippedArchived).toBe(1);

    const all = await getOverview(services, { view: "grades", includeArchived: true });
    expect(all.items.map((item) => (item as { id: string }).id).sort()).toEqual(["w1", "w2"]);
    expect(all.skippedArchived).toBe(0);
  });

  it("separates result truncation from scan truncation in totals", async () => {
    const work = Array.from({ length: 25 }, (_, i) => workRow(`w${i}`, { dueDate: undefined }));
    const { services } = fakeServices({ courses: [COURSE], work: { c1: work } });
    const result = await getOverview(services, { view: "due", limit: 10 });
    expect(result.total).toBe(25);
    expect(result.returned).toBe(10);
    expect(result.truncated).toBe(true);
    expect(result.scanTruncated).toBe(false);
    expect(result.hint).toMatch(/Showing 10 of 25/);
  });
});
