import { describe, it, expect } from "vitest";
import { draftToQueueItems } from "@/lib/social-publisher";
import type { FacebookDraft } from "@/lib/database";

function draft(over: Partial<FacebookDraft> = {}): FacebookDraft {
  return {
    id: 1,
    sku: "X",
    triggerType: "content_template",
    language: "fr",
    postText: "Texte FR",
    postTextEn: "EN text",
    imagePath: null,
    imageUrl: null,
    imageUrls: [],
    videoUrl: null,
    reelsVideoUrl: null,
    oldPrice: null,
    newPrice: null,
    status: "approved",
    scheduledAt: null,
    publishedAt: null,
    facebookPostId: null,
    channels: {},
    createdAt: 0,
    hookId: null,
    approvedAt: null,
    reviewedBy: null,
    reviewNotes: null,
    unsplashImageUrl: null,
    unsplashPhotographer: null,
    unsplashPhotographerUrl: null,
    ...over,
  } as FacebookDraft;
}

describe("draftToQueueItems", () => {
  it("maps ameublo (FR) to a 'both' item when FB+IG ameublo are active", () => {
    const items = draftToQueueItems(draft(), ["fb_ameublo", "ig_ameublo"]);
    expect(items).toHaveLength(1);
    expect(items[0].platform).toBe("both");
    expect(items[0].payload).toMatchObject({ brand: "ameublo", caption: "Texte FR" });
  });

  it("collapses a single active platform to that platform (not 'both')", () => {
    const items = draftToQueueItems(draft(), ["fb_ameublo"]);
    expect(items).toHaveLength(1);
    expect(items[0].platform).toBe("facebook");
  });

  it("emits one item per brand for a bilingual draft (ameublo FR + furnish EN)", () => {
    const items = draftToQueueItems(draft(), ["fb_ameublo", "fb_furnish", "ig_ameublo"]);
    expect(items.map((i) => i.payload.brand).sort()).toEqual(["ameublo", "furnish"]);

    const ameublo = items.find((i) => i.payload.brand === "ameublo")!;
    expect(ameublo.platform).toBe("both"); // fb + ig active
    expect(ameublo.payload.caption).toBe("Texte FR");

    const furnish = items.find((i) => i.payload.brand === "furnish")!;
    expect(furnish.platform).toBe("facebook"); // only fb_furnish active
    expect(furnish.payload.caption).toBe("EN text");
  });

  it("skips furnish (EN) when the draft has no EN caption — never posts FR to an EN channel", () => {
    const items = draftToQueueItems(draft({ postTextEn: null }), ["fb_ameublo", "fb_furnish"]);
    expect(items.map((i) => i.payload.brand)).toEqual(["ameublo"]);
  });

  it("returns [] when no active channel matches", () => {
    expect(draftToQueueItems(draft(), [])).toEqual([]);
  });

  it("includes videos and brand-localized images in the payload", () => {
    const items = draftToQueueItems(
      draft({
        imageUrls: ["https://cdn.example.com/api/image-preview?locale=fr&u=1"],
        videoUrl: "https://v/fb.mp4",
        reelsVideoUrl: "https://v/ig.mp4",
      }),
      ["fb_furnish"],
    );
    const p = items[0].payload;
    expect(p.videoUrl).toBe("https://v/fb.mp4");
    expect(p.reelsVideoUrl).toBe("https://v/ig.mp4");
    // furnish = EN → the image-preview locale is rewritten fr→en.
    expect(p.imageUrls?.[0]).toContain("locale=en");
    expect(p.imageUrl).toBe(p.imageUrls?.[0]);
  });

  it("falls back to the single imageUrl when imageUrls is empty", () => {
    const items = draftToQueueItems(
      draft({ imageUrl: "https://cdn.example.com/raw.jpg", imageUrls: [] }),
      ["fb_ameublo"],
    );
    expect(items[0].payload.imageUrls).toEqual(["https://cdn.example.com/raw.jpg"]);
    expect(items[0].payload.imageUrl).toBe("https://cdn.example.com/raw.jpg");
  });
});
