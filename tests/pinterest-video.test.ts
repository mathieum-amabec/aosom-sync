import { describe, it, expect } from "vitest";
import { studioVideoToPin, pinDescription, type StudioVideoForPin } from "@/lib/pinterest-video";

const video = (o: Partial<StudioVideoForPin> = {}): StudioVideoForPin => ({
  id: 7,
  lang: "fr",
  style: "vitrine",
  label: "Canapé 2 places en lin",
  video_url: "https://blob.example/7.mp4",
  skus: ["833-524V07CW"],
  caption: "Un salon qui se monte tout seul.\n\nCanapé — 244,99 $ : https://ameublodirect.ca/products/canape\n\nLivraison gratuite.\n#ameublodirect #décoration",
  ...o,
});
const product = { shopify_handle: "canape-2-places", image1: "https://cdn.example/canape.jpg" };

describe("studioVideoToPin", () => {
  it("builds a FR Pin that links to the Ameublo product page, with the product photo as cover", () => {
    expect(studioVideoToPin(video(), product)).toEqual({
      ok: true,
      input: {
        title: "Canapé 2 places en lin",
        description: "Un salon qui se monte tout seul.\n\nCanapé — 244,99 $\n\nLivraison gratuite.\n#ameublodirect #décoration",
        link: "https://ameublodirect.ca/products/canape-2-places",
        videoUrl: "https://blob.example/7.mp4",
        coverImageUrl: "https://cdn.example/canape.jpg",
        altText: "Canapé 2 places en lin",
      },
    });
  });

  it("links EN videos to Furnish Direct", () => {
    const r = studioVideoToPin(video({ lang: "en", caption: "A sofa.\n#furnishdirect" }), product);
    expect(r.ok && r.input.link).toBe("https://furnishdirect.ca/products/canape-2-places");
  });

  it("lets the caller pick a better cover", () => {
    const r = studioVideoToPin(video(), product, { coverImageUrl: "https://cdn.example/frame.jpg" });
    expect(r.ok && r.input.coverImageUrl).toBe("https://cdn.example/frame.jpg");
  });

  it("falls back to the style name when the video has no label", () => {
    const r = studioVideoToPin(video({ label: null, style: "top3" }), product);
    expect(r.ok && r.input.title).toBe("Top 3");
  });

  it("refuses — with a reason — what cannot make a useful Pin", () => {
    expect(studioVideoToPin(video(), null)).toMatchObject({ ok: false, reason: expect.stringContaining("page produit") });
    expect(studioVideoToPin(video(), { shopify_handle: null, image1: "x" })).toMatchObject({ ok: false });
    expect(studioVideoToPin(video(), { shopify_handle: "h", image1: null })).toMatchObject({ ok: false, reason: expect.stringContaining("couverture") });
    expect(studioVideoToPin(video({ lang: null }), product)).toMatchObject({ ok: false, reason: expect.stringContaining("langue") });
    expect(studioVideoToPin(video({ caption: "https://x.ca" }), product)).toMatchObject({ ok: false, reason: expect.stringContaining("légende") });
  });
});

describe("pinDescription", () => {
  it("strips the links but keeps the words around them, and drops a line that was only a URL", () => {
    expect(pinDescription("A\nB : https://x.ca/p\nhttps://y.ca\nC")).toBe("A\nB\nC");
    expect(pinDescription("Voir：https://x.ca")).toBe("Voir");
  });
  it("never lets a supplier brand through", () => {
    expect(pinDescription("Un classique de Outsunny pour le patio")).not.toMatch(/outsunny/i);
  });
});
