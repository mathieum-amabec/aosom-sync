/**
 * Clip selector for the remix engine (Module F).
 *
 * Pulls already-rendered demand-gen videos out of `video_demand_gen` and joins
 * `products` to filter by theme → product_type. Reuses the Module B selector
 * plumbing verbatim: the shared 5-minute TTL cache (Turso bills per row read)
 * and the injectable DB seam (`getSelectorDb`), so these queries are unit-tested
 * against an in-memory libsql with no live Turso connection.
 *
 * Requires the supporting index (added to database.ts initSchema):
 *   CREATE INDEX IF NOT EXISTS idx_vdg_ratio_blob
 *     ON video_demand_gen(ratio, blob_url, sku, duration_sec)
 */
import { cached, cacheKey } from "@/lib/selectors/cache";
import { getSelectorDb } from "@/lib/selectors/db";
import type { RemixConfig, RemixClip } from "./types";

/**
 * Theme → product_type prefixes. Matched with `LIKE %type%` so a theme entry
 * like "Patio" also catches "Patio Furniture" / "Outdoor Patio". An empty list
 * (e.g. "soldes") or an unknown theme means "no product_type filter" — a fully
 * random draw across the whole library.
 */
export const THEME_PRODUCT_TYPES: Record<string, string[]> = {
  "ete-cour": ["Patio", "Garden", "Outdoor", "Pool"],
  maison: ["Indoor Furniture", "Storage", "Lighting"],
  enfants: ["Kids", "Toys", "Baby"],
  bureau: ["Office Furniture", "Computer", "Desk"],
  animaux: ["Pet", "Cat", "Dog"],
  soldes: [], // tous (random)
};

/** Default compilation length when max_clips is unset. */
export const DEFAULT_MAX_CLIPS = 8;

/** Map a duration_filter bucket to its source duration_sec, or null. */
function durationFromFilter(filter?: string): number | null {
  switch (filter) {
    case "6s":
      return 6;
    case "15s":
      return 15;
    case "30s":
      return 30;
    default:
      return null;
  }
}

/**
 * Select clips for a remix. Only rows with a non-null `blob_url` are eligible
 * (a clip with no uploaded asset can't be concatenated). Random order so each
 * build is a fresh edit. Cached 5 minutes per (theme, category, ratio,
 * duration_filter, max_clips) — same pattern as the Module B selectors.
 */
export async function selectRemixClips(config: RemixConfig): Promise<RemixClip[]> {
  const limit = config.max_clips ?? DEFAULT_MAX_CLIPS;
  const durationSec = durationFromFilter(config.duration_filter);
  const key = cacheKey("selectRemixClips", {
    theme: config.theme,
    category: config.category ?? null,
    ratio: config.ratio,
    duration_filter: config.duration_filter ?? null,
    max_clips: limit,
  });

  return cached(key, async () => {
    const db = await getSelectorDb();

    const where: string[] = ["vd.ratio = ?", "vd.blob_url IS NOT NULL"];
    const args: (string | number)[] = [config.ratio];

    // Explicit category overrides the theme map. Otherwise expand the theme to
    // its product_type set; an empty set ("soldes"/unknown) skips the filter.
    if (config.category) {
      where.push("p.product_type LIKE ?");
      args.push(`%${config.category}%`);
    } else {
      const types = THEME_PRODUCT_TYPES[config.theme] ?? [];
      if (types.length > 0) {
        where.push(`(${types.map(() => "p.product_type LIKE ?").join(" OR ")})`);
        for (const t of types) args.push(`%${t}%`);
      }
    }

    if (durationSec !== null) {
      where.push("vd.duration_sec = ?");
      args.push(durationSec);
    }

    const sql = `
      SELECT vd.sku, vd.title_fr, vd.blob_url, vd.duration_sec, vd.ratio
      FROM video_demand_gen vd
      JOIN products p ON p.sku = vd.sku
      WHERE ${where.join(" AND ")}
      ORDER BY RANDOM()
      LIMIT ?`;
    args.push(limit);

    const result = await db.execute({ sql, args });
    return result.rows.map((r) => ({
      sku: String(r.sku),
      title_fr: r.title_fr != null ? String(r.title_fr) : "",
      blob_url: String(r.blob_url),
      duration_sec: Number(r.duration_sec),
      ratio: String(r.ratio),
    }));
  });
}
