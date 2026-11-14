import { describe, it, expect } from "vitest";
import { lifestyleFirst } from "@/lib/costway/gallery";
import type { analyzeAndCleanGallery } from "@/lib/auto-import/verify";

type Analyze = typeof analyzeAndCleanGallery;
const ok = { ok: true, reasons: [], flags: [], unreachable: [] };
const fake = (r: Awaited<ReturnType<Analyze>>): Analyze => (async () => r) as unknown as Analyze;

describe("lifestyleFirst — the store photo rule for Costway", () => {
  it("puts a clean lifestyle photo first when one exists", async () => {
    const r = await lifestyleFirst(["a", "b", "c"], fake({ analysis: ok, cleaned: { images: ["b", "a", "c"], dropped: [], promoted: true, hasLifestyle: true, reasons: [] } }));
    expect(r).toMatchObject({ images: ["b", "a", "c"], outcome: "lifestyle" });
  });
  it("falls back to the clean studio shot only when no lifestyle photo exists", async () => {
    const r = await lifestyleFirst(["a", "b", "c"], fake({ analysis: ok, cleaned: { images: ["a", "b", "c"], dropped: [], promoted: false, hasLifestyle: false, reasons: [] } }));
    expect(r.outcome).toBe("studio");
  });
  it("needs a human when no photo can lead, or when the photos could not be checked", async () => {
    const none = await lifestyleFirst(["a"], fake({ analysis: ok, cleaned: { images: ["a"], dropped: [], promoted: false, hasLifestyle: false, reasons: ["no_clean_primary_photo"] } }));
    expect(none.outcome).toBe("no_alternative");
    const down = await lifestyleFirst(["a"], fake({ analysis: { ...ok, ok: false, reasons: ["gallery_judge_unavailable"] }, cleaned: null }));
    expect(down).toMatchObject({ outcome: "no_alternative", images: ["a"] });
  });
});
