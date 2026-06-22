import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  addWatermarkToImage,
  uploadWatermarkedImage,
  bundledFontsDir,
  buildFontconfigXml,
  FOOTER_HEIGHT,
} from "@/lib/image-watermark";

// Spy-able Vercel Blob so the IG-hosting path never hits the network.
const blobPut = vi.fn(async (p: string) => ({ url: `https://blob.test/${p}` }));
const blobDel = vi.fn(async () => {});
vi.mock("@vercel/blob", () => ({
  put: (...args: unknown[]) => blobPut(...(args as [string])),
  del: (...args: unknown[]) => blobDel(...(args as [])),
}));

/** Build a solid-colour PNG of the given size to act as a fake Shopify CDN image. */
async function makeImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();
}

/** Stub global fetch so the download inside addWatermarkToImage returns `img`. */
function stubFetchWith(img: Buffer, ok = true, status = 200) {
  const ab = img.buffer.slice(img.byteOffset, img.byteOffset + img.byteLength);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok, status, arrayBuffer: async () => ab }),
  );
}

describe("addWatermarkToImage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a non-empty PNG buffer", async () => {
    stubFetchWith(await makeImage(300, 200));
    const out = await addWatermarkToImage("https://cdn.example.com/a.jpg", "ameublo");
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    // PNG magic bytes.
    expect(out.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("output dimensions are >= input dimensions (same width, taller)", async () => {
    stubFetchWith(await makeImage(300, 200));
    const out = await addWatermarkToImage("https://cdn.example.com/a.jpg", "ameublo");
    const meta = await sharp(out).metadata();
    expect(meta.width).toBeGreaterThanOrEqual(300);
    expect(meta.height).toBeGreaterThanOrEqual(200);
  });

  it("adds the footer: output height === input height + FOOTER_HEIGHT, width unchanged", async () => {
    stubFetchWith(await makeImage(640, 480));
    const out = await addWatermarkToImage("https://cdn.example.com/a.jpg", "furnish");
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480 + FOOTER_HEIGHT);
  });

  it("works for both brands", async () => {
    stubFetchWith(await makeImage(200, 200));
    const a = await addWatermarkToImage("https://cdn.example.com/a.jpg", "ameublo");
    stubFetchWith(await makeImage(200, 200));
    const f = await addWatermarkToImage("https://cdn.example.com/a.jpg", "furnish");
    expect((await sharp(a).metadata()).height).toBe(200 + FOOTER_HEIGHT);
    expect((await sharp(f).metadata()).height).toBe(200 + FOOTER_HEIGHT);
  });

  it("throws on a failed download", async () => {
    stubFetchWith(Buffer.alloc(0), false, 404);
    await expect(addWatermarkToImage("https://cdn.example.com/missing.jpg", "ameublo")).rejects.toThrow(/HTTP 404/);
  });

  it("throws on an unknown brand", async () => {
    stubFetchWith(await makeImage(100, 100));
    // @ts-expect-error — deliberately passing an invalid brand
    await expect(addWatermarkToImage("https://cdn.example.com/a.jpg", "nope")).rejects.toThrow(/unknown brand/);
  });
});

describe("DM Sans bundling (fontconfig)", () => {
  it("ships valid Regular + Bold TTFs in src/fonts", () => {
    const dir = bundledFontsDir();
    expect(dir.replace(/\\/g, "/")).toMatch(/src\/fonts$/);
    for (const file of ["DMSans-Regular.ttf", "DMSans-Bold.ttf"]) {
      const p = path.join(dir, file);
      expect(fs.existsSync(p), `${file} should exist`).toBe(true);
      // TrueType magic: 0x00010000
      const magic = fs.readFileSync(p).subarray(0, 4);
      expect([...magic]).toEqual([0x00, 0x01, 0x00, 0x00]);
    }
  });

  it("fontconfig doc registers the fonts dir + cache and keeps the system include", () => {
    const xml = buildFontconfigXml("/var/task/src/fonts", "/tmp/fc");
    expect(xml).toContain("<dir>/var/task/src/fonts</dir>");
    expect(xml).toContain("<cachedir>/tmp/fc</cachedir>");
    expect(xml).toContain('<include ignore_missing="yes">/etc/fonts/fonts.conf</include>');
  });
});

describe("uploadWatermarkedImage (Instagram blob hosting)", () => {
  afterEach(() => { vi.unstubAllGlobals(); blobPut.mockClear(); blobDel.mockClear(); });

  it("watermarks, uploads a PNG to Blob, and returns a public URL", async () => {
    stubFetchWith(await makeImage(300, 200));
    const hosted = await uploadWatermarkedImage("https://cdn.example.com/a.jpg", "ameublo");

    expect(hosted.url).toMatch(/^https:\/\/blob\.test\/social-watermark\/ameublo\/.+\.png$/);
    expect(blobPut).toHaveBeenCalledTimes(1);
    const [, buffer, opts] = blobPut.mock.calls[0] as unknown as [string, Buffer, { access: string; contentType: string }];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
    expect(opts.access).toBe("public");
    expect(opts.contentType).toBe("image/png");
  });

  it("cleanup() deletes the temp blob", async () => {
    stubFetchWith(await makeImage(120, 120));
    const hosted = await uploadWatermarkedImage("https://cdn.example.com/a.jpg", "furnish");
    await hosted.cleanup();
    expect(blobDel).toHaveBeenCalledWith(hosted.url);
  });
});
