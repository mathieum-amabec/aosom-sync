import { describe, it, expect } from "vitest";
import {
  ameubloSvg,
  ameubloPoseAt,
  defaultChoreography,
  accessoryForCampaign,
  accessorySvg,
  bubbleLineFor,
  BUBBLE_LINES_FR,
  NEUTRAL_POSE,
} from "@/lib/ameublo-sprite";
import { overlayLayout, buildOverlayGraph, bubbleSvg } from "@/lib/video-engines/ameublo-overlay";

describe("ameubloSvg", () => {
  it("draws a standalone square SVG at the requested size", () => {
    const svg = ameubloSvg(NEUTRAL_POSE, 300);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain('width="300" height="300"');
    expect(svg).toContain("#D4A853"); // brand gold body
  });

  it("changes the face with the pose", () => {
    expect(ameubloSvg({ ...NEUTRAL_POSE, eyes: "happy" })).toContain("M45 49 Q50 43 55 49");
    expect(ameubloSvg({ ...NEUTRAL_POSE, mouth: "o" })).toContain('cx="60" cy="59"');
  });

  it("can drop the floor shadow (when he floats in a top corner)", () => {
    expect(ameubloSvg(NEUTRAL_POSE)).toContain('opacity=".12"');
    expect(ameubloSvg(NEUTRAL_POSE, 360, { shadow: false })).not.toContain('opacity=".12"');
  });

  it("draws each seasonal accessory, and nothing for none", () => {
    for (const a of ["tuque", "santa", "leaf", "witch"] as const) expect(accessorySvg(a)).not.toBe("");
    expect(accessorySvg("none")).toBe("");
  });
});

describe("ameubloPoseAt — the 'Ameublo présente' choreography", () => {
  const ch = defaultChoreography(15, "none");

  it("is deterministic: the same instant always gives the same frame", () => {
    expect(ameubloPoseAt(3.3, ch)).toEqual(ameubloPoseAt(3.3, ch));
  });

  it("starts below the frame and has landed by the end of the entrance", () => {
    expect(ameubloPoseAt(0, ch).bodyY).toBeGreaterThan(100);
    expect(Math.abs(ameubloPoseAt(0.6, ch).bodyY)).toBeLessThan(1);
  });

  it("waves hello with the right arm after entering", () => {
    expect(ameubloPoseAt(1.0, ch).armLift).toBe(1);
  });

  it("points at a left bubble with the LEFT arm, so the arm never crosses his face", () => {
    const p = ameubloPoseAt(ch.bubble.start + 0.5, ch);
    expect(p.leftArmLift).toBe(1);
    expect(p.leftArmAngle).toBeLessThan(0);
    expect(p.armLift).toBe(0);
    expect(p.look.dx).toBeLessThan(0);
  });

  it("points with the right arm when the bubble is on the right", () => {
    const right = defaultChoreography(15, "none", "right");
    const p = ameubloPoseAt(right.bubble.start + 0.5, right);
    expect(p.armLift).toBe(1);
    expect(p.leftArmLift).toBe(0);
  });

  it("waves goodbye at the end", () => {
    const p = ameubloPoseAt(14.5, ch);
    expect(p.armLift).toBe(1);
    expect(p.eyes).toBe("happy");
  });

  it("keeps the bubble inside the clip, even a short one", () => {
    const short = defaultChoreography(5);
    expect(short.bubble.start).toBeGreaterThan(0);
    expect(short.bubble.end).toBeLessThanOrEqual(5);
    expect(short.bubble.end).toBeGreaterThan(short.bubble.start);
  });
});

describe("accessoryForCampaign", () => {
  it("dresses him for the season, and leaves unknown campaigns bare", () => {
    expect(accessoryForCampaign("halloween-2026")).toBe("witch");
    expect(accessoryForCampaign("noel-2026")).toBe("santa");
    expect(accessoryForCampaign("hiver-2026")).toBe("tuque");
    expect(accessoryForCampaign("automne-2026")).toBe("leaf");
    expect(accessoryForCampaign("maison-2026")).toBe("none");
  });
});

describe("bubbleLineFor", () => {
  it("picks a stable line per SKU from the approved list", () => {
    expect(bubbleLineFor("838-212WT")).toBe(bubbleLineFor("838-212WT"));
    expect(BUBBLE_LINES_FR).toContain(bubbleLineFor("830-254"));
  });
});

describe("overlay layout and graph", () => {
  it("keeps Ameublo and his bubble inside a 1080×1920 frame, top or bottom", () => {
    for (const vertical of ["top", "bottom"] as const) {
      const L = overlayLayout(1080, 1920, { vertical, bottomMargin: 170 }, "APPROUVÉ PAR AMEUBLO");
      expect(L.spriteX).toBeGreaterThanOrEqual(0);
      expect(L.spriteX + L.sprite).toBeLessThanOrEqual(1080);
      expect(L.bubbleX).toBeGreaterThanOrEqual(0);
      expect(L.bubbleY + L.bubbleH).toBeLessThanOrEqual(1920);
    }
  });

  it("at the bottom, stays above the brand bar", () => {
    const L = overlayLayout(1080, 1920, { vertical: "bottom", bottomMargin: 170 }, "BON CHOIX");
    // The drawing's floor line is ~92% down the sprite box.
    expect(L.spriteY + L.sprite * 0.92).toBeLessThanOrEqual(1920 - 170 + L.sprite * 0.06);
  });

  it("builds a graph with the bubble only when there is text", () => {
    const L = overlayLayout(1080, 1920, { vertical: "top" }, "BON CHOIX");
    const ch = defaultChoreography(15);
    const withText = buildOverlayGraph(L, ch, "t/b.txt", "fonts/DMSans.ttf");
    expect(withText).toContain("drawtext=fontfile=fonts/DMSans.ttf:textfile=t/b.txt");
    expect(withText).toContain(`between(t,${ch.bubble.start},${ch.bubble.end})`);
    expect(withText).toMatch(/\[vout\]$/);
    const bare = buildOverlayGraph(L, ch, null, "fonts/DMSans.ttf");
    expect(bare).not.toContain("drawtext");
    expect(bare).toContain("[0:v][1:v]overlay");
  });

  it("draws the bubble at the requested size", () => {
    expect(bubbleSvg(400, 120)).toContain('width="400" height="120"');
  });
});
