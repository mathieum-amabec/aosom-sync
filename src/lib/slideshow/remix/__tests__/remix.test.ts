import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { selectRemixClips, THEME_PRODUCT_TYPES } from "@/lib/slideshow/remix/selector";
import { renderRemix } from "@/lib/slideshow/remix/render";
import { __setSelectorDbForTests } from "@/lib/selectors/db";
import { clearSelectorCache } from "@/lib/selectors/cache";
import type { RemixConfig } from "@/lib/slideshow/remix/types";

const now = Math.floor(Date.now() / 1000);

/**
 * Fresh in-memory catalog with just the columns the remix selector touches.
 * `video_demand_gen.blob_url` is intentionally nullable here (the prod table
 * has it NOT NULL) so the "skip null blob_url" rule can be exercised.
 */
async function seedDb(): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  await db.batch([
    `CREATE TABLE products (
      sku TEXT PRIMARY KEY, product_type TEXT,
      shopify_product_id TEXT
    )`,
    `CREATE TABLE video_demand_gen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL, title_fr TEXT, ratio TEXT NOT NULL,
      duration_sec INTEGER NOT NULL, blob_path TEXT, blob_url TEXT,
      created_at INTEGER, updated_at INTEGER
    )`,
  ]);
  return db;
}

/** Insert a product + one demand-gen clip in a single helper. */
function seedClip(
  db: Client,
  opts: { sku: string; product_type: string; ratio?: string; duration?: number; blob_url?: string | null; title?: string },
) {
  const ratio = opts.ratio ?? "9:16";
  const duration = opts.duration ?? 15;
  const blobUrl = opts.blob_url === undefined ? `https://blob.example/${opts.sku}.mp4` : opts.blob_url;
  return db.batch(
    [
      { sql: `INSERT OR IGNORE INTO products (sku, product_type, shopify_product_id) VALUES (?,?,?)`, args: [opts.sku, opts.product_type, `sp-${opts.sku}`] },
      {
        sql: `INSERT INTO video_demand_gen (sku, title_fr, ratio, duration_sec, blob_path, blob_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
        args: [opts.sku, opts.title ?? `Titre ${opts.sku}`, ratio, duration, `p/${opts.sku}`, blobUrl, now, now],
      },
    ],
    "write",
  );
}

const baseConfig: RemixConfig = {
  theme: "soldes",
  ratio: "9:16",
  brand: "ameublo",
  language: "fr",
};

beforeEach(() => {
  clearSelectorCache();
});

afterEach(() => {
  __setSelectorDbForTests(null);
});

describe("selectRemixClips", () => {
  it("returns only clips with a non-null blob_url", async () => {
    const db = await seedDb();
    await seedClip(db, { sku: "HAS", product_type: "Patio" });
    await seedClip(db, { sku: "NULLED", product_type: "Patio", blob_url: null });
    __setSelectorDbForTests(db);

    const clips = await selectRemixClips({ ...baseConfig, theme: "soldes", max_clips: 20 });
    const skus = clips.map((c) => c.sku);
    expect(skus).toContain("HAS");
    expect(skus).not.toContain("NULLED");
    expect(clips.every((c) => typeof c.blob_url === "string" && c.blob_url.length > 0)).toBe(true);
    db.close();
  });

  it("maps theme 'ete-cour' to the Patio/Garden/Outdoor product_types", async () => {
    const db = await seedDb();
    await seedClip(db, { sku: "PAT", product_type: "Patio Furniture" });
    await seedClip(db, { sku: "GAR", product_type: "Garden" });
    await seedClip(db, { sku: "OUT", product_type: "Outdoor Lighting" });
    await seedClip(db, { sku: "OFF", product_type: "Office Furniture" });
    await seedClip(db, { sku: "PET", product_type: "Pet Supplies" });
    __setSelectorDbForTests(db);

    const clips = await selectRemixClips({ ...baseConfig, theme: "ete-cour", max_clips: 20 });
    const skus = clips.map((c) => c.sku).sort();
    expect(skus).toEqual(["GAR", "OUT", "PAT"]);
    expect(skus).not.toContain("OFF");
    expect(skus).not.toContain("PET");
    // sanity: the map drives the filter
    expect(THEME_PRODUCT_TYPES["ete-cour"]).toContain("Patio");
    db.close();
  });

  it("caches results for the same query (5-min TTL) until cleared", async () => {
    const db = await seedDb();
    await seedClip(db, { sku: "A", product_type: "Patio" });
    __setSelectorDbForTests(db);

    const first = await selectRemixClips({ ...baseConfig, theme: "ete-cour", max_clips: 20 });
    expect(first.map((c) => c.sku).sort()).toEqual(["A"]);

    // A new matching row is invisible while the cached window is live.
    await seedClip(db, { sku: "B", product_type: "Garden" });
    const second = await selectRemixClips({ ...baseConfig, theme: "ete-cour", max_clips: 20 });
    expect(second.map((c) => c.sku).sort()).toEqual(["A"]);

    // After clearing the cache the new row appears.
    clearSelectorCache();
    const third = await selectRemixClips({ ...baseConfig, theme: "ete-cour", max_clips: 20 });
    expect(third.map((c) => c.sku).sort()).toEqual(["A", "B"]);
    db.close();
  });

  it("filters to a single source duration when duration_filter is set", async () => {
    const db = await seedDb();
    await seedClip(db, { sku: "SHORT", product_type: "Patio", duration: 6 });
    await seedClip(db, { sku: "LONG", product_type: "Patio", duration: 30 });
    __setSelectorDbForTests(db);

    const clips = await selectRemixClips({ ...baseConfig, theme: "ete-cour", duration_filter: "6s", max_clips: 20 });
    expect(clips.map((c) => c.sku)).toEqual(["SHORT"]);
    db.close();
  });
});

describe("renderRemix (dryRun)", () => {
  it("returns a manifest of the selected clips without invoking ffmpeg", async () => {
    const db = await seedDb();
    await seedClip(db, { sku: "PAT", product_type: "Patio", duration: 15 });
    await seedClip(db, { sku: "GAR", product_type: "Garden", duration: 15 });
    __setSelectorDbForTests(db);

    const result = await renderRemix({ ...baseConfig, theme: "ete-cour", dryRun: true, max_clips: 20 });

    expect(result.blobUrl).toBeUndefined();
    expect(result.clipCount).toBe(2);
    expect(result.manifest).toBeDefined();
    const m = result.manifest!;
    expect(m.dryRun).toBe(true);
    expect(m.theme).toBe("ete-cour");
    expect(m.clips).toHaveLength(2);
    expect(m.clips.map((c) => c.sku).sort()).toEqual(["GAR", "PAT"]);
    // intro(2) + 15 + 15 + outro(2) - 3*0.5 xfades = 32.5
    expect(m.estimatedDurationSec).toBe(32.5);
    expect(m.wouldUploadTo).toBe(
      `slideshows/ameublo/remix/ete-cour/9x16/${m.wouldUploadTo.split("/").pop()}`,
    );
    expect(m.wouldUploadTo.startsWith("slideshows/ameublo/remix/ete-cour/9x16/")).toBe(true);
    expect(m.wouldUploadTo.endsWith(".mp4")).toBe(true);
    db.close();
  });
});
