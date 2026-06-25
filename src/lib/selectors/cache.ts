/**
 * Tiny in-memory TTL cache shared by the content selectors.
 *
 * Turso bills per row read, so selectors cache their result sets for 5 minutes
 * keyed by (selector name + serialized options). The cache is process-local and
 * best-effort — on Vercel each function instance keeps its own, which is fine:
 * the catalog only changes once a day (the sync), so 5-minute staleness is
 * invisible to content generation.
 */

const TTL_MS = 5 * 60 * 1000; // 5 minutes

interface Entry<T> {
  data: T;
  expiry: number;
}

const store = new Map<string, Entry<unknown>>();

/** Stable cache key for a selector call. */
export function cacheKey(selector: string, opts: unknown): string {
  return `${selector}:${JSON.stringify(opts ?? {})}`;
}

/**
 * Return the cached value for `key`, or compute it with `loader`, cache it for
 * 5 minutes, and return it. Concurrent callers with the same key each run the
 * loader at most once per TTL window (no in-flight dedupe — selectors are cheap
 * and idempotent, so a rare double-load is harmless).
 */
export async function cached<T>(key: string, loader: () => Promise<T>, now: number = Date.now()): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiry > now) return hit.data as T;
  const data = await loader();
  store.set(key, { data, expiry: now + TTL_MS });
  return data;
}

/** Test/maintenance helper: drop all cached selector results. */
export function clearSelectorCache(): void {
  store.clear();
}
