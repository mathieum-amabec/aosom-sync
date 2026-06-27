import { describe, it, expect } from "vitest";
import { getSlideshowHook, getSlogan, SLIDESHOW_HOOKS } from "@/lib/slideshow/hooks";

describe("getSlideshowHook", () => {
  it("returns a catchy hook from the category pool — never the technical series id", () => {
    for (let i = 0; i < 20; i++) {
      const hook = getSlideshowHook("best_sellers", "fr");
      expect(SLIDESHOW_HOOKS.best_sellers.fr).toContain(hook);
      expect(hook).not.toMatch(/best-sellers-\d/); // not the id
    }
  });

  it("maps each category to its own pool", () => {
    expect(SLIDESHOW_HOOKS.price_drops.fr).toContain(getSlideshowHook("price_drops", "fr"));
    expect(SLIDESHOW_HOOKS.top3.fr).toContain(getSlideshowHook("top3", "fr"));
    expect(SLIDESHOW_HOOKS.kids_cars.fr).toContain(getSlideshowHook("kids_cars", "fr"));
  });

  it("falls back to seasonal_ete for an unknown seasonal_* key, else best_sellers", () => {
    expect(SLIDESHOW_HOOKS.seasonal_ete.fr).toContain(getSlideshowHook("seasonal_hiver", "fr"));
    expect(SLIDESHOW_HOOKS.best_sellers.fr).toContain(getSlideshowHook("totally-unknown", "fr"));
  });

  it("supports EN", () => {
    expect(SLIDESHOW_HOOKS.office.en).toContain(getSlideshowHook("office", "en"));
  });
});

describe("getSlogan", () => {
  it("returns the seed unchanged when Claude is unavailable (no key / error)", async () => {
    // No ANTHROPIC_API_KEY in the test env → getAnthropicClient/create throws → fallback.
    const seed = "Ton bureau mérite mieux 💻";
    expect(await getSlogan(seed, "fr")).toBe(seed);
  });

  it("returns empty for an empty seed without calling Claude", async () => {
    expect(await getSlogan("   ", "fr")).toBe("");
  });
});
