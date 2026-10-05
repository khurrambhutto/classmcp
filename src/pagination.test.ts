import { describe, expect, it, vi } from "vitest";
import { scanAll } from "./pagination.js";

describe("scanAll", () => {
  it("exhausts every page and preserves order", async () => {
    const items = [1, 2, 3, 4, 5];
    const result = await scanAll<number>(async (pageToken) => {
      const start = pageToken ? Number(pageToken) : 0;
      return { items: items.slice(start, start + 2), nextPageToken: start + 2 < items.length ? String(start + 2) : undefined };
    });
    expect(result).toEqual({ items, pages: 3, truncated: false, nextPageToken: null });
  });

  it("stops at maxPages with an explicit continuation token", async () => {
    const fetchPage = vi.fn(async (pageToken: string | undefined) => ({
      items: [pageToken ?? "first"],
      nextPageToken: `${Number(pageToken ?? 0) + 1}`,
    }));
    const result = await scanAll(fetchPage, { maxPages: 3, maxItems: 1000 });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(result.truncated).toBe(true);
    expect(result.pages).toBe(3);
    expect(result.nextPageToken).toBe("3");
  });

  it("stops at maxItems with an explicit continuation token", async () => {
    const fetchPage = vi.fn(async (pageToken: string | undefined) => ({
      items: [1, 2, 3],
      nextPageToken: pageToken ? undefined : "next",
    }));
    const result = await scanAll(fetchPage, { maxItems: 3, maxPages: 100 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ items: [1, 2, 3], pages: 1, truncated: true, nextPageToken: "next" });
  });

  it("does not mark a complete single-page list as truncated", async () => {
    const result = await scanAll(async () => ({ items: ["a"], nextPageToken: null }), { maxItems: 1 });
    expect(result.truncated).toBe(false);
    expect(result.nextPageToken).toBeNull();
  });
});
