import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { baseLayerSvg, labelLayerSvg, wrapText, escapeXml, writeLayerPng } from "@/lib/studio/text-layers";
import { studioGeometry } from "@/lib/studio/render";
import os from "node:os";
import path from "node:path";

const geo = studioGeometry(1080, 1920);
const texts = { locale: "fr" as const, labels: true, title: "Balancelle 3 places avec auvent", price: "249,99 $", cta: "Livraison gratuite partout au Canada" };

describe("text layers (SVG, replacing ffmpeg drawtext)", () => {
  it("escapes XML so titles with & < > can't break the SVG", () => {
    expect(escapeXml(`Table & chaises <2> "pro"`)).toBe("Table &amp; chaises &lt;2&gt; &quot;pro&quot;");
    expect(baseLayerSvg(geo, { ...texts, title: "Table & chaises" })).toContain("Table &amp; chaises");
  });

  it("base layer carries the title band, the CTA pill and the domain", () => {
    const s = baseLayerSvg(geo, texts);
    const titleText = [...s.matchAll(/text-anchor="middle">([^<]+)<\/text>/g)].map((m) => m[1]).join(" ");
    expect(titleText).toContain("Balancelle 3 places avec auvent");
    expect(s).toContain("Livraison gratuite partout au Canada");
    expect(s).toContain("ameublodirect.ca");
    expect(s).toContain(`width="1080" height="1920"`);
  });

  it("omits empty texts and switches domain/labels with the locale", () => {
    const s = baseLayerSvg(geo, { ...texts, locale: "en", title: "", cta: "" });
    expect(s).not.toContain("<rect");
    expect(s).toContain("furnishdirect.ca");
    expect(labelLayerSvg(geo, { ...texts, locale: "en" }, 0)).toContain(">BEFORE<");
  });

  it("AVANT layer has no price; APRÈS layer carries label + price; labels can be turned off", () => {
    expect(labelLayerSvg(geo, texts, 0)).toContain(">AVANT<");
    expect(labelLayerSvg(geo, texts, 0)).not.toContain("249,99");
    const after = labelLayerSvg(geo, texts, 1);
    expect(after).toContain(">APRÈS<");
    expect(after).toContain("249,99 $");
    const noLabels = labelLayerSvg(geo, { ...texts, labels: false }, 1);
    expect(noLabels).not.toContain("APRÈS");
    expect(noLabels).toContain("249,99 $");
  });

  it("wraps long titles to at most two lines", () => {
    const lines = wrapText("Ensemble de patio 4 pièces en rotin tressé avec coussins épais et table en verre trempé", 56, 960);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0].length).toBeGreaterThan(10);
  });

  it("rasterises to a transparent PNG of the full frame", async () => {
    const out = path.join(os.tmpdir(), `studio-layer-${Date.now()}.png`);
    await writeLayerPng(labelLayerSvg(geo, texts, 1), out);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([1080, 1920, true]);
  });
});
