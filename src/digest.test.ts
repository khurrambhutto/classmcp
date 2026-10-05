import { describe, expect, it } from "vitest";
import {
  buildWorkRows, daysUntil, dueToDay, dueToMillis, normalizeAttachments, summarizeMaterial, trimText, trimWithStatus,
} from "./digest.js";

describe("digest helpers", () => {
  it("converts a Classroom due date to UTC millis", () => {
    expect(dueToMillis({ year: 2026, month: 9, day: 10 }, { hours: 23, minutes: 59 }))
      .toBe(Date.UTC(2026, 8, 10, 23, 59));
  });

  it("returns undefined when there is no due date", () => {
    expect(dueToMillis(undefined, undefined)).toBeUndefined();
    expect(dueToDay(undefined)).toBeNull();
  });

  it("formats the due day as YYYY-MM-DD", () => {
    expect(dueToDay({ year: 2026, month: 1, day: 5 })).toBe("2026-01-05");
  });

  it("counts days left rounding up", () => {
    const now = Date.UTC(2026, 8, 9, 12, 0);
    expect(daysUntil(Date.UTC(2026, 8, 10, 23, 59), now)).toBe(2);
    expect(daysUntil(Date.UTC(2026, 8, 1), now)).toBeLessThan(0);
  });

  it("trims long text with an ellipsis", () => {
    expect(trimText("  hello   world  ", 20)).toBe("hello world");
    expect(trimText("abcdefghij", 5)).toBe("abcde…");
  });

  it("summarizes materials without dumping JSON", () => {
    expect(summarizeMaterial({ driveFile: { driveFile: { title: "Week7.pdf" } } } as never))
      .toBe("drive:Week7.pdf");
    expect(summarizeMaterial({ link: { url: "https://example.com" } } as never))
      .toBe("link:https://example.com");
  });
});

describe("normalizeAttachments", () => {
  it("maps googleapis Material shapes", () => {
    const out = normalizeAttachments([
      { driveFile: { driveFile: { id: "d1", title: "Notes.pdf" } } },
      { form: { formUrl: "https://forms.example/f", title: "Survey" } },
      { link: { url: "https://example.com", title: "Example" } },
      { youtubeVideo: { id: "vid1", title: "Vid", alternateLink: "https://youtu.be/vid1" } },
    ]);
    expect(out).toEqual([
      { kind: "driveFile", id: "d1", name: "Notes.pdf", url: null },
      { kind: "form", id: null, name: "Survey", url: "https://forms.example/f" },
      { kind: "link", id: null, name: "Example", url: "https://example.com" },
      { kind: "youtube", id: "vid1", name: "Vid", url: "https://youtu.be/vid1" },
    ]);
  });

  it("maps Attachment shapes with the youTubeVideo spelling", () => {
    const out = normalizeAttachments([
      { driveFile: { id: "d2", title: "HW.pdf" } },
      { form: { formUrl: "https://forms.example/f2" } },
      { link: { url: "https://example.org" } },
      { youTubeVideo: { id: "vid2", title: "T" } },
    ]);
    expect(out).toEqual([
      { kind: "driveFile", id: "d2", name: "HW.pdf", url: null },
      { kind: "form", id: null, name: null, url: "https://forms.example/f2" },
      { kind: "link", id: null, name: null, url: "https://example.org" },
      { kind: "youtube", id: "vid2", name: "T", url: "https://www.youtube.com/watch?v=vid2" },
    ]);
  });

  it("falls back for form and youtube urls", () => {
    expect(normalizeAttachments([{ form: { responderUri: "https://forms.example/r" } }])).toEqual([
      { kind: "form", id: null, name: null, url: "https://forms.example/r" },
    ]);
    expect(normalizeAttachments([{ youtubeVideo: { youtubeVideo: { id: "vid3" } } }])).toEqual([
      { kind: "youtube", id: "vid3", name: null, url: "https://www.youtube.com/watch?v=vid3" },
    ]);
  });

  it("skips junk entries and empty lists", () => {
    expect(normalizeAttachments([])).toEqual([]);
    expect(normalizeAttachments([null, "nope", 7])).toEqual([]);
  });
});

describe("trimWithStatus", () => {
  it("reports full, trimmed, or empty — never a bare ambiguous string", () => {
    expect(trimWithStatus("hello world", 20)).toEqual({ value: "hello world", status: "full" });
    expect(trimWithStatus("hello world", 5)).toEqual({ value: "hello…", status: "trimmed" });
    expect(trimWithStatus("", 10)).toEqual({ value: "", status: "empty" });
    expect(trimWithStatus("   ", 10)).toEqual({ value: "", status: "empty" });
    expect(trimWithStatus(undefined, 10)).toEqual({ value: "", status: "empty" });
    expect(trimWithStatus("nonempty", 0)).toEqual({ value: "…", status: "trimmed" });
  });
});

const now = Date.UTC(2026, 8, 10, 12, 0);
const course = { id: "c1", name: "Physics 101" };

const work = [
  { id: "w1", title: "Overdue Essay", dueDate: { year: 2026, month: 9, day: 1 }, maxPoints: 100, workType: "ASSIGNMENT", alternateLink: "https://classroom/w1" },
  { id: "w2", title: "Upcoming Quiz", dueDate: { year: 2026, month: 9, day: 15 }, maxPoints: 50 },
  { id: "w3", title: "Far Project", dueDate: { year: 2026, month: 9, day: 30 }, maxPoints: 100 },
  { id: "w4", title: "No Due Worksheet", maxPoints: 20 },
  { id: "w5", title: "Turned In Report", dueDate: { year: 2026, month: 9, day: 12 }, maxPoints: 100 },
  { id: "w6", title: "Graded Lab", dueDate: { year: 2026, month: 9, day: 3 }, maxPoints: 50 },
  { id: "w7", title: "Late Done", dueDate: { year: 2026, month: 9, day: 5 }, maxPoints: 100 },
];

const subs = [
  { courseWorkId: "w1", state: "CREATED", late: false },
  { courseWorkId: "w2", state: "NEW", late: true },
  { courseWorkId: "w3", state: "NEW", late: false },
  { courseWorkId: "w5", state: "TURNED_IN", late: false },
  { courseWorkId: "w6", state: "RETURNED", late: false, assignedGrade: 42.5 },
  { courseWorkId: "w7", state: "TURNED_IN", late: true, assignedGrade: 80 },
];

describe("buildWorkRows", () => {
  it("due shows upcoming work soonest-first and undated last, excluding overdue", () => {
    const rows = buildWorkRows(course, work, subs, "due", 7, now, "concise");
    expect(rows.map((r) => r.id)).toEqual(["w2", "w4"]);
    expect(rows[0].daysLeft).toBe(5);
    expect(rows[0].late).toBe(true);
    expect(rows[1].daysLeft).toBeNull();
    expect(rows[1].due).toBe("none");
  });

  it("due drops overdue, far-future and TURNED_IN work", () => {
    const rows = buildWorkRows(course, work, subs, "due", 7, now, "concise");
    expect(rows.map((r) => r.id)).not.toContain("w1");
    expect(rows.map((r) => r.id)).not.toContain("w3");
    expect(rows.map((r) => r.id)).not.toContain("w5");
  });

  it("missing keeps open work that is late or overdue, most recently due first", () => {
    const rows = buildWorkRows(course, work, subs, "missing", 7, now, "concise");
    expect(rows.map((r) => r.id)).toEqual(["w2", "w1"]);
    expect(rows.map((r) => r.id)).not.toContain("w7");
    expect(rows[0].daysLeft).toBe(5);
    expect(rows[1].daysLeft).toBe(-9);
  });

  it("grades keeps graded work regardless of state", () => {
    const rows = buildWorkRows(course, work, subs, "grades", 7, now, "concise");
    expect(rows.map((r) => r.id)).toEqual(["w6", "w7"]);
    expect(rows[0].grade).toBe(42.5);
    expect(rows.map((r) => r.id)).not.toContain("w1");
  });

  it("detailed adds link and workType, concise omits them", () => {
    const concise = buildWorkRows(course, work, subs, "missing", 7, now, "concise");
    expect(concise.find((r) => r.id === "w1")?.link).toBeUndefined();
    expect(concise.find((r) => r.id === "w1")?.workType).toBeUndefined();
    const detailed = buildWorkRows(course, work, subs, "missing", 7, now, "detailed");
    expect(detailed.find((r) => r.id === "w1")?.link).toBe("https://classroom/w1");
    expect(detailed.find((r) => r.id === "w1")?.workType).toBe("ASSIGNMENT");
    expect(detailed.find((r) => r.id === "w1")).toMatchObject({ course: "Physics 101", courseId: "c1", points: 100 });
  });
});
