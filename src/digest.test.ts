import { describe, expect, it } from "vitest";
import { daysUntil, dueToDay, dueToMillis, summarizeMaterial, trimText } from "./digest.js";

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
