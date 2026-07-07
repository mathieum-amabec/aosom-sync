import { describe, it, expect } from "vitest";
import {
  slideshowDurationSeconds,
  perClipSeconds,
  perClipFrames,
  formatPrice,
  ctaText,
  pickRandomMusic,
  buildProductOverlaySvg,
  buildBrandBandSvg,
  buildFilterComplex,
  buildFfmpegArgs,
  type SlideshowProduct,
} from "@/lib/video-engines/ffmpeg-slideshow";
import { VIDEO_BRAND } from "@/lib/video-brand-tokens";

const PRODUCT: SlideshowProduct = {
  name: "Canapé sectionnel réversible",
  price: 499.99,
  imageUrl: "https://cdn.example.com/sofa.jpg",
};

// ─── Duration math ────────────────────────────────────────────────────

describe("slideshow duration", () => {
  it("clamps the total runtime into the brand duration target", () => {
    const { min, max } = VIDEO_BRAND.format.durationTarget;
    for (let n = 1; n <= 6; n++) {
      const total = slideshowDurationSeconds(n);
      expect(total).toBeGreaterThanOrEqual(min);
      expect(total).toBeLessThanOrEqual(max);
    }
  });

  it("1 product is padded up to the minimum (15s), 6 fills the max (30s)", () => {
    expect(slideshowDurationSeconds(1)).toBe(15);
    expect(slideshowDurationSeconds(6)).toBe(30);
  });

  it("per-clip seconds * count equals the clamped total", () => {
    for (let n = 1; n <= 6; n++) {
      expect(perClipSeconds(n) * n).toBeCloseTo(slideshowDurationSeconds(n), 5);
    }
  });

  it("3 products → 5s/clip → 125 frames (matches the brief's d=125)", () => {
    expect(perClipSeconds(3)).toBe(5);
    expect(perClipFrames(3)).toBe(125);
  });

  it("perClipSeconds(0) is 0 and does not divide by zero", () => {
    expect(perClipSeconds(0)).toBe(0);
  });
});

// ─── Locale formatting ────────────────────────────────────────────────

describe("locale formatting", () => {
  it("formats price per locale (CA conventions)", () => {
    expect(formatPrice(249.9, "fr")).toBe("249.90 $");
    expect(formatPrice(249.9, "en")).toBe("$249.90");
  });

  it("localizes the CTA", () => {
    expect(ctaText("fr")).toBe("Lien en bio 👆");
    expect(ctaText("en")).toBe("Link in bio 👆");
  });
});

// ─── Music selection ──────────────────────────────────────────────────

describe("pickRandomMusic", () => {
  it("returns null when no tracks are available", () => {
    expect(pickRandomMusic([])).toBeNull();
    expect(pickRandomMusic(["", "   "])).toBeNull();
  });

  it("always returns one of the provided tracks", () => {
    const tracks = ["/m/a.mp3", "/m/b.mp3", "/m/c.mp3"];
    for (let i = 0; i < 50; i++) expect(tracks).toContain(pickRandomMusic(tracks));
  });
});

// ─── SVG overlays ─────────────────────────────────────────────────────

describe("SVG overlays", () => {
  it("product overlay embeds title, localized price and CTA, and brand colors", () => {
    const svg = buildProductOverlaySvg(PRODUCT, "fr");
    expect(svg).toContain("Canapé sectionnel réversible");
    expect(svg).toContain("499.99 $");
    expect(svg).toContain("Lien en bio");
    expect(svg).toContain(VIDEO_BRAND.colors.gold);
    expect(svg).toMatch(new RegExp(`width="${VIDEO_BRAND.format.width}"`));
    expect(svg).toMatch(new RegExp(`height="${VIDEO_BRAND.format.height}"`));
  });

  it("escapes XML-significant characters in the product name", () => {
    const svg = buildProductOverlaySvg({ ...PRODUCT, name: "Sofa <b> & \"Co\"" }, "en");
    expect(svg).toContain("&lt;b&gt;");
    expect(svg).toContain("&amp;");
    expect(svg).not.toMatch(/<text[^>]*>Sofa <b>/);
  });

  it("brand band sits at the bottom and shows the store URL", () => {
    const svg = buildBrandBandSvg();
    const bandTop = VIDEO_BRAND.format.height - VIDEO_BRAND.overlay.bandHeight;
    expect(svg).toContain(VIDEO_BRAND.overlay.storeUrl);
    expect(svg).toContain(`y="${bandTop}"`);
    expect(svg).toContain(VIDEO_BRAND.colors.navy);
  });
});

// ─── Filter graph ─────────────────────────────────────────────────────

describe("buildFilterComplex", () => {
  it("emits one Ken Burns zoompan per slide with the brief's z expression", () => {
    const { filterComplex } = buildFilterComplex({
      slideCount: 3,
      framesPerClip: 125,
      hasBand: false,
      hasMusic: false,
      musicVolumeDb: -18,
    });
    const zoompans = filterComplex.match(/zoompan=z='min\(zoom\+0\.0015,1\.5\)':d=125/g) ?? [];
    expect(zoompans).toHaveLength(3);
    expect(filterComplex).toContain("concat=n=3:v=1:a=0[slides]");
  });

  it("overlays the band input after the slides and labels video 'branded'", () => {
    const { filterComplex, videoLabel, audioLabel } = buildFilterComplex({
      slideCount: 2,
      framesPerClip: 188,
      hasBand: true,
      hasMusic: false,
      musicVolumeDb: -18,
    });
    // 2 slides → band is input index 2.
    expect(filterComplex).toContain("[slides][2:v]overlay=0:0");
    expect(videoLabel).toBe("branded");
    expect(audioLabel).toBeNull();
  });

  it("places music after band and normalizes its volume", () => {
    const { filterComplex, audioLabel } = buildFilterComplex({
      slideCount: 2,
      framesPerClip: 188,
      hasBand: true,
      hasMusic: true,
      musicVolumeDb: -18,
    });
    // 2 slides + band → music is input index 3.
    expect(filterComplex).toContain("[3:a]volume=-18dB[aout]");
    expect(audioLabel).toBe("aout");
  });

  it("indexes music correctly when there is no band", () => {
    const { filterComplex } = buildFilterComplex({
      slideCount: 4,
      framesPerClip: 125,
      hasBand: false,
      hasMusic: true,
      musicVolumeDb: -18,
    });
    expect(filterComplex).toContain("[4:a]volume=-18dB[aout]");
  });
});

// ─── Argument vector ──────────────────────────────────────────────────

describe("buildFfmpegArgs", () => {
  const baseArgs = {
    slidePaths: ["/w/slide-0.png", "/w/slide-1.png", "/w/slide-2.png"],
    bandPath: "/w/band.png",
    musicPath: "/w/track.mp3",
    perClipSeconds: 5,
    framesPerClip: 125,
    musicVolumeDb: -18,
    outputPath: "/out/video.mp4",
  };

  it("loops each still for the clip duration and adds band + music inputs", () => {
    const args = buildFfmpegArgs(baseArgs);
    // One "-loop 1 -t 5 -i <slide>" per slide.
    const loopCount = args.filter((a, i) => a === "-loop" && args[i + 1] === "1").length;
    expect(loopCount).toBe(4); // 3 slides + band
    expect(args).toContain("/w/slide-0.png");
    expect(args).toContain("/w/band.png");
    expect(args).toContain("/w/track.mp3");
  });

  it("maps the branded video + audio and encodes a faststart H.264 MP4", () => {
    const args = buildFfmpegArgs(baseArgs);
    expect(args).toContain("-filter_complex");
    expect(args).toEqual(expect.arrayContaining(["-map", "[branded]"]));
    expect(args).toEqual(expect.arrayContaining(["-map", "[aout]"]));
    expect(args).toEqual(expect.arrayContaining(["-c:v", "libx264"]));
    expect(args).toEqual(expect.arrayContaining(["-pix_fmt", "yuv420p"]));
    expect(args).toContain("-shortest");
    expect(args).toEqual(expect.arrayContaining(["-movflags", "+faststart"]));
    expect(args[args.length - 1]).toBe("/out/video.mp4");
  });

  it("omits audio mapping and codec when there is no music", () => {
    const args = buildFfmpegArgs({ ...baseArgs, musicPath: null });
    expect(args).not.toContain("/w/track.mp3");
    expect(args).not.toContain("-shortest");
    expect(args).not.toContain("[aout]");
    expect(args).toEqual(expect.arrayContaining(["-map", "[branded]"]));
  });
});
