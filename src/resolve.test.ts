import { describe, expect, it } from "vitest";
import { pickOne } from "./resolve.js";

const courses = [
  { id: "c1", name: "Physics 101" },
  { id: "c2", name: "Advanced Physics" },
  { id: "c3", name: "History" },
  { id: "c4", name: "Mathematics" },
];

describe("pickOne", () => {
  it("matches exactly, ignoring case and whitespace", () => {
    const result = pickOne(courses, { name: "  PHYSICS   101 " }, "course");
    expect(result).toEqual({ ok: true, item: courses[0] });
  });

  it("prefers the exact match over substring matches", () => {
    const items = [{ id: "a", name: "Lab" }, { id: "b", name: "Lab Report" }];
    expect(pickOne(items, { name: "lab" }, "course")).toEqual({ ok: true, item: items[0] });
  });

  it("matches by substring in either direction when unique", () => {
    const byFragment = pickOne(courses, { name: "story" }, "course");
    expect(byFragment).toEqual({ ok: true, item: courses[2] });
    const bySuperset = pickOne(courses, { name: "advanced physics 202" }, "course");
    expect(bySuperset).toEqual({ ok: true, item: courses[1] });
  });

  it("matches weakly by shared tokens of 3+ chars", () => {
    const items = [{ id: "m1", name: "Intro to Biology" }, { id: "m2", name: "Chem" }];
    const result = pickOne(items, { name: "biology lab exam" }, "course");
    expect(result).toEqual({ ok: true, item: items[0] });
    expect(pickOne(items, { name: "it to of" }, "course").ok).toBe(false);
  });

  it("reports no match with known names and ids", () => {
    const result = pickOne(courses, { name: "chem" }, "course");
    expect(result).toEqual({
      ok: false,
      message: 'No course matches "chem". Known: Physics 101 (c1), Advanced Physics (c2), History (c3), Mathematics (c4).',
    });
  });

  it("lists at most 10 known candidates", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `id${i}`, name: `Course ${i}` }));
    const result = pickOne(many, { name: "chem" }, "course");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Course 0 (id0)");
    expect(result.message).toContain("Course 9 (id9)");
    expect(result.message).not.toContain("Course 10");
  });

  it("reports ambiguity between tied items", () => {
    const result = pickOne(courses, { name: "physics" }, "course");
    expect(result).toEqual({
      ok: false,
      message: 'Multiple courses match "physics": Physics 101 (c1), Advanced Physics (c2). Pass the courseId parameter.',
    });
  });

  it("pluralizes the kind label in ambiguity messages", () => {
    const items = [{ id: "w1", name: "Essay Draft" }, { id: "w2", name: "Essay Final" }];
    const result = pickOne(items, { name: "essay" }, "assignment");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('Multiple assignments match "essay": Essay Draft (w1), Essay Final (w2). Pass the assignmentId parameter.');
  });

  it("matches by id and reports unknown ids", () => {
    expect(pickOne(courses, { id: "c3" }, "course")).toEqual({ ok: true, item: courses[2] });
    expect(pickOne(courses, { id: "nope" }, "course")).toEqual({
      ok: false,
      message: 'No course with id "nope".',
    });
  });

  it("lets the id win over the name when both are given", () => {
    expect(pickOne(courses, { id: "c3", name: "Physics" }, "course")).toEqual({ ok: true, item: courses[2] });
    expect(pickOne(courses, { id: "zzz", name: "Physics" }, "course")).toEqual({
      ok: false,
      message: 'No course with id "zzz".',
    });
  });

  it("asks for an id or name when neither is given", () => {
    expect(pickOne(courses, {}, "course")).toEqual({ ok: false, message: "Provide course id or name." });
    expect(pickOne(courses, { name: "   " }, "course")).toEqual({ ok: false, message: "Provide course id or name." });
  });
});
