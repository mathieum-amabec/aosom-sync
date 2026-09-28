import { describe, it, expect } from "vitest";
import { parseRenderRequest, isAllowedMediaUrl, studioTimeline, TRANSITIONS, getTransition } from "@/lib/studio/options";
import { buildStudioGraph, filterPath } from "@/lib/studio/render";
import { trackDisplayName } from "@/lib/studio/music";

const SHOP = "https://cdn.shopify.com/s/files/1/0678/1327/7801/files/";
const valid = () => ({
  sku: "84A-054V05BK",
  shopifyProductId: "7793456250985",
  productTitle: "Balancelle",
  before: { url: `${SHOP}a.jpg`, fit: "contain" },
  after: { url: `${SHOP}b.jpg`, fit: "cover" },
  transition: "slider",
  durationSec: 10,
  format: "9:16",
  locale: "fr",
  musicUrl: "https://jcskqp8orcub9i0l.public.blob.vercel-storage.com/studio/music/x.mp3",
  musicStartSec: 12,
  texts: { labels: true, title: "Balancelle 3 places", price: "249,99 $", cta: "Livraison gratuite" },
});

describe("isAllowedMediaUrl", () => {
  it("accepts Shopify CDN and our public Blob store over https only", () => {
    expect(isAllowedMediaUrl(`${SHOP}a.jpg`)).toBe(true);
    expect(isAllowedMediaUrl("https://abc.public.blob.vercel-storage.com/studio/x.jpg")).toBe(true);
    expect(isAllowedMediaUrl("http://cdn.shopify.com/a.jpg")).toBe(false);
    expect(isAllowedMediaUrl("https://img-us.aosomcdn.com/a.jpg")).toBe(false);
    expect(isAllowedMediaUrl("https://evil.com/cdn.shopify.com/a.jpg")).toBe(false);
    expect(isAllowedMediaUrl("not a url")).toBe(false);
  });
});

describe("parseRenderRequest", () => {
  it("accepts a complete request and normalises it", () => {
    const r = parseRenderRequest(valid());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatchObject({ durationSec: 10, format: "9:16", musicStartSec: 12, before: { fit: "contain" }, after: { fit: "cover" } });
    }
  });
  it.each([
    ["same image twice", { after: { url: `${SHOP}a.jpg`, fit: "cover" } }, /deux images différentes/],
    ["foreign image host", { before: { url: "https://img-us.aosomcdn.com/a.jpg" } }, /non autorisée/],
    ["unknown transition", { transition: "spin" }, /Transition/],
    ["bad duration", { durationSec: 7 }, /Durée/],
    ["bad format", { format: "16:9" }, /Format/],
    ["foreign music", { musicUrl: "https://evil.com/a.mp3" }, /Musique/],
    ["missing product", { sku: "" }, /Produit/],
  ])("rejects %s", (_name, patch, msg) => {
    const r = parseRenderRequest({ ...valid(), ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });
  it("treats an empty music URL as no music and clamps the start", () => {
    const r = parseRenderRequest({ ...valid(), musicUrl: "", musicStartSec: 9999 });
    expect(r.ok && r.value.musicUrl).toBe(null);
    expect(r.ok && r.value.musicStartSec).toBe(180);
  });
  it("defaults labels on and trims texts", () => {
    const r = parseRenderRequest({ ...valid(), texts: { title: "  x  " } });
    expect(r.ok && r.value.texts).toEqual({ labels: true, title: "x", price: "", cta: "" });
  });
});

describe("studioTimeline", () => {
  it("centres the transition and makes both stills cover the whole clip", () => {
    const t = studioTimeline(10, 2);
    expect(t).toEqual({ transitionStart: 4, transitionEnd: 6, beforeSec: 6, afterSec: 6 });
    // before input (0→6) and after input (4→10) overlap exactly over the transition
    expect(t.transitionStart + t.afterSec).toBe(10);
  });
});

describe("buildStudioGraph", () => {
  const base = {
    w: 1080,
    h: 1920,
    durationSec: 6,
    textFiles: { domain: "/tmp/d.txt", before: "/tmp/b.txt", after: "/tmp/a.txt", title: "/tmp/t.txt", price: "/tmp/p.txt", cta: "/tmp/c.txt" },
    font: "src/fonts/DMSans-Bold.ttf",
    hasMusic: true,
  };
  it("uses the chosen xfade transition at the computed offset", () => {
    const tr = getTransition("circle")!;
    const g = buildStudioGraph({ ...base, transition: tr });
    const t = studioTimeline(6, tr.duration);
    expect(g).toContain(`xfade=transition=circleopen:duration=${tr.duration.toFixed(2)}:offset=${t.transitionStart.toFixed(2)}`);
    expect(g).not.toContain("[line]");
  });
  it("adds the moving divider line only for the slider", () => {
    const g = buildStudioGraph({ ...base, transition: getTransition("slider")! });
    expect(g).toContain("xfade=transition=wiperight");
    expect(g).toMatch(/\[line\]overlay=x='if\(between\(t\\,/);
  });
  it("omits optional texts and uses silent audio without music", () => {
    const g = buildStudioGraph({ ...base, transition: getTransition("dissolve")!, hasMusic: false, textFiles: { domain: "/tmp/d.txt" } });
    expect(g).not.toContain("t.txt");
    expect(g).not.toContain("b.txt");
    expect(g).toContain("[3:a]anull[aout]");
    expect(g).toContain("[vout]");
  });
  it("every transition in the menu builds a graph", () => {
    for (const tr of TRANSITIONS) expect(buildStudioGraph({ ...base, transition: tr })).toContain(`transition=${tr.xfade}`);
  });
});

describe("filterPath", () => {
  it("escapes Windows drive colons and backslashes for the filtergraph", () => {
    expect(filterPath("C:\\tmp\\x.txt")).toBe("C\\:/tmp/x.txt");
    expect(filterPath("/tmp/x.txt")).toBe("/tmp/x.txt");
  });
});

describe("trackDisplayName", () => {
  it("turns blob pathnames into readable names", () => {
    expect(trackDisplayName("studio/music/mixkit-golden-storm-470.mp3")).toBe("Golden Storm");
    expect(trackDisplayName("studio/music/joyinsound-no-copyright-chill-music-403411.mp3")).toBe("Chill Music");
    expect(trackDisplayName("studio/music/Ma_Chanson.mp3")).toBe("Ma Chanson");
  });
});
