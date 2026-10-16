import { describe, it, expect, vi } from "vitest";
import {
  mirrorPathFor,
  mirrorUrlFor,
  mirroredFirst,
  resolveVideoUrl,
  loadMirroredPaths,
  UGC_BLOB_BASE,
} from "@/lib/ugc-video-mirror";

const SRC = "https://img.example-cdn.com/aosomweb/customer/CA/831-930V00CW.mp4";

describe("mirrorPathFor", () => {
  it("maps a customer video URL to a deterministic blob path", () => {
    expect(mirrorPathFor(SRC)).toBe("ugc-videos/CA/831-930V00CW.mp4");
    expect(mirrorPathFor("https://x/customer/us/A1-b.mp4?x=1")).toBe("ugc-videos/US/A1-b.mp4");
  });
  it("returns null for anything else", () => {
    expect(mirrorPathFor("https://x/customer/FR/a.mp4")).toBeNull();
    expect(mirrorPathFor("https://x/video.mp4")).toBeNull();
  });
});

describe("resolveVideoUrl", () => {
  it("uses our mirror when the path is in the manifest", () => {
    const r = resolveVideoUrl(SRC, new Set(["ugc-videos/CA/831-930V00CW.mp4"]));
    expect(r).toEqual({ url: `${UGC_BLOB_BASE}/ugc-videos/CA/831-930V00CW.mp4`, mirrored: true });
    expect(r.url).not.toMatch(/aosom/i);
  });
  it("falls back to the source URL when not mirrored", () => {
    expect(resolveVideoUrl(SRC, new Set())).toEqual({ url: SRC, mirrored: false });
  });
});

describe("mirroredFirst", () => {
  it("puts mirrored candidates first and keeps relative order", () => {
    const c = [
      { sku: "a", videoUgc: "https://x/customer/CA/a.mp4" },
      { sku: "b", videoUgc: "https://x/customer/CA/b.mp4" },
      { sku: "c", videoUgc: "https://x/customer/US/c.mp4" },
      { sku: "d", videoUgc: "https://x/customer/CA/d.mp4" },
    ];
    const out = mirroredFirst(c, new Set(["ugc-videos/US/c.mp4", "ugc-videos/CA/b.mp4"]));
    expect(out.map((x) => x.sku)).toEqual(["b", "c", "a", "d"]);
  });
});

describe("loadMirroredPaths", () => {
  it("reads the manifest", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ paths: ["ugc-videos/CA/a.mp4", 3] }) });
    const s = await loadMirroredPaths(f as unknown as typeof fetch);
    expect([...s]).toEqual(["ugc-videos/CA/a.mp4"]);
    expect(f.mock.calls[0][0]).toBe(mirrorUrlFor("ugc-videos/manifest.json"));
  });
  it("treats any failure as nothing mirrored", async () => {
    expect((await loadMirroredPaths(vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch)).size).toBe(0);
    expect((await loadMirroredPaths(vi.fn().mockRejectedValue(new Error("x")) as unknown as typeof fetch)).size).toBe(0);
  });
});
