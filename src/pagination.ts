// Bounded pagination for Google list endpoints. Every scan reports whether an
// internal safety budget stopped it, so callers can never silently present a
// partial list as complete.

export type ScanResult<T> = {
  items: T[];
  pages: number;
  /** True when maxPages/maxItems stopped the scan before the last page. */
  truncated: boolean;
  /** Page token to continue from (only set when truncated). */
  nextPageToken: string | null;
};

export type ScanOptions = {
  /** Safety budget for items scanned, per list. Default 1000. */
  maxItems?: number;
  /** Safety budget for pages fetched, per list. Default 10. */
  maxPages?: number;
};

export const DEFAULT_SCAN_MAX_ITEMS = 1000;
export const DEFAULT_SCAN_MAX_PAGES = 10;

/**
 * Fetch every page of a list until the API stops returning a next page token
 * or a safety budget is hit. `fetchPage` may itself wrap retries; the token it
 * receives is undefined on the first page.
 */
export async function scanAll<T>(
  fetchPage: (pageToken: string | undefined, page: number) => Promise<{ items: T[]; nextPageToken?: string | null | undefined }>,
  opts: ScanOptions = {},
): Promise<ScanResult<T>> {
  const maxItems = opts.maxItems ?? DEFAULT_SCAN_MAX_ITEMS;
  const maxPages = opts.maxPages ?? DEFAULT_SCAN_MAX_PAGES;
  const items: T[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await fetchPage(pageToken, pages);
    pages++;
    items.push(...page.items);
    pageToken = page.nextPageToken ?? undefined;
    if (!pageToken) return { items, pages, truncated: false, nextPageToken: null };
    if (pages >= maxPages || items.length >= maxItems) {
      return { items, pages, truncated: true, nextPageToken: pageToken };
    }
  }
}
