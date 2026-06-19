import { describe, it, expect } from "vitest";
// The loader's pure transform helpers. Importing the .mjs does not run main()
// (it is guarded) nor load @libsql/client (dynamic-imported only in --apply).
import { parseAsset, buildRows, buildSnapshot } from "../scripts/load-demand-gen-db.mjs";

describe("parseAsset", () => {
  it("parses ratio (x→:) and duration from an asset path", () => {
    expect(parseAsset("demand-gen/01-0415/01-0415_16x9_15s.mp4")).toEqual({ ratio: "16:9", duration_sec: 15 });
    expect(parseAsset("01-0415_1x1_6s.mp4")).toEqual({ ratio: "1:1", duration_sec: 6 });
    expect(parseAsset("x/845-039V01GY_9x16_30s.mp4")).toEqual({ ratio: "9:16", duration_sec: 30 });
  });

  it("returns null for unparseable names", () => {
    expect(parseAsset("demand-gen/01-0415/cover.png")).toBeNull();
    expect(parseAsset("")).toBeNull();
    expect(parseAsset(undefined)).toBeNull();
  });
});

const FIXTURE = {
  summary: { total_output_assets: 3 },
  videos: [
    { sku: "84B-146BU", title_fr: "Tapis bleu", shopify_product_id: "gid://shopify/Product/1" },
    // 01-0415 intentionally absent from videos[] → metadata falls back to null
  ],
  uploads: [
    { sku: "84B-146BU", blob_path: "demand-gen/84B-146BU/84B-146BU_9x16_30s.mp4", blob_url: "https://b/9x16_30.mp4", bytes: 30 },
    { sku: "84B-146BU", blob_path: "demand-gen/84B-146BU/84B-146BU_16x9_6s.mp4", blob_url: "https://b/16x9_6.mp4", bytes: 6 },
    { sku: "01-0415", blob_path: "demand-gen/01-0415/01-0415_1x1_15s.mp4", blob_url: "https://b/1x1_15.mp4", bytes: 15 },
    // dropped: no blob_url
    { sku: "01-0415", blob_path: "demand-gen/01-0415/01-0415_1x1_6s.mp4", bytes: 99 },
    // dropped: unparseable name
    { sku: "01-0415", blob_path: "demand-gen/01-0415/poster.png", blob_url: "https://b/poster.png" },
  ],
};

describe("buildRows", () => {
  it("joins uploads to video metadata and parses ratio/duration", () => {
    const rows = buildRows(FIXTURE);
    expect(rows).toHaveLength(3); // 2 dropped (no blob_url, unparseable)
    const r = rows.find((x) => x.sku === "84B-146BU" && x.ratio === "16:9");
    expect(r).toMatchObject({
      sku: "84B-146BU",
      title_fr: "Tapis bleu",
      shopify_product_id: "gid://shopify/Product/1",
      ratio: "16:9",
      duration_sec: 6,
      blob_url: "https://b/16x9_6.mp4",
      bytes: 6,
    });
  });

  it("falls back to null metadata when the sku is missing from videos[]", () => {
    const rows = buildRows(FIXTURE);
    const r = rows.find((x) => x.sku === "01-0415");
    if (!r) throw new Error("expected a 01-0415 row in the result");
    expect(r.title_fr).toBeNull();
    expect(r.shopify_product_id).toBeNull();
  });

  it("sorts deterministically by sku, ratio, duration for clean snapshot diffs", () => {
    const rows = buildRows(FIXTURE);
    expect(rows.map((r) => `${r.sku}|${r.ratio}|${r.duration_sec}`)).toEqual([
      "01-0415|1:1|15",
      "84B-146BU|16:9|6",
      "84B-146BU|9:16|30",
    ]);
  });

  it("drops uploads with no blob_url or an unparseable name", () => {
    const rows = buildRows(FIXTURE);
    expect(rows.some((r) => r.blob_url == null)).toBe(false);
    expect(rows.some((r) => r.blob_path?.endsWith(".png"))).toBe(false);
  });

  it("handles an empty/missing manifest without throwing", () => {
    expect(buildRows({})).toEqual([]);
    expect(buildRows({ uploads: [], videos: [] })).toEqual([]);
  });
});

describe("buildSnapshot", () => {
  it("wraps rows with count + unique sorted skus", () => {
    const rows = buildRows(FIXTURE);
    const snap = buildSnapshot(rows, "2026-06-18T00:00:00.000Z");
    expect(snap.count).toBe(3);
    expect(snap.skus).toEqual(["01-0415", "84B-146BU"]);
    expect(snap.generated_at).toBe("2026-06-18T00:00:00.000Z");
    expect(snap.generated_from).toBe("out/demand-gen-manifest.json");
    expect(snap.assets).toBe(rows);
  });
});
