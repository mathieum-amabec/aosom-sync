/** Studio persistence against the REAL schema in an in-memory libsql DB. */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Client } from "@libsql/client";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

let db: Client;
let m: typeof import("@/lib/studio/db");

const req = {
  sku: "SKU-1",
  shopifyProductId: "1",
  productTitle: "Produit",
  before: { url: "https://cdn.shopify.com/a.jpg", fit: "contain" as const },
  after: { url: "https://cdn.shopify.com/b.jpg", fit: "cover" as const },
  transition: "slider",
  durationSec: 6 as const,
  format: "9:16" as const,
  locale: "fr" as const,
  musicUrl: null,
  musicStartSec: 0,
  texts: { labels: true, title: "", price: "", cta: "" },
};

beforeAll(async () => {
  db = await (await import("@/lib/database")).ensureSchema();
  m = await import("@/lib/studio/db");
});
beforeEach(async () => {
  await db.execute("DELETE FROM studio_images");
  await db.execute("DELETE FROM studio_renders");
  await db.execute("DELETE FROM publication_queue");
});

describe("studio_images", () => {
  it("adds, lists (newest first), counts today's AI images and deletes", async () => {
    const a = await m.addStudioImage({ sku: "SKU-1", url: "https://x/1.jpg", source: "upload" });
    const b = await m.addStudioImage({ sku: "SKU-1", url: "https://x/2.jpg", source: "ai", parentUrl: "https://x/1.jpg", prompt: "Pièce vide" });
    await m.addStudioImage({ sku: "SKU-2", url: "https://x/3.jpg", source: "ai" });
    expect((await m.listStudioImages("SKU-1")).map((i) => i.id)).toEqual([b.id, a.id]);
    expect(b).toMatchObject({ source: "ai", parentUrl: "https://x/1.jpg", prompt: "Pièce vide" });
    expect(await m.countAiImagesToday()).toBe(2);
    await m.deleteStudioImage(a.id);
    expect(await m.getStudioImage(a.id)).toBeNull();
  });
});

describe("studio_renders", () => {
  it("goes rendering → ready and keeps the params", async () => {
    const id = await m.createStudioRender(req);
    expect((await m.getStudioRender(id))?.status).toBe("rendering");
    await m.finishStudioRender(id, { videoUrl: "https://blob/x.mp4" });
    const r = await m.getStudioRender(id);
    expect(r).toMatchObject({ status: "ready", videoUrl: "https://blob/x.mp4", params: { transition: "slider", format: "9:16" } });
    await m.setStudioRenderQueueId(id, 42);
    expect((await m.getStudioRender(id))?.queueId).toBe(42);
  });
  it("records errors", async () => {
    const id = await m.createStudioRender(req);
    await m.finishStudioRender(id, { error: "ffmpeg boom" });
    expect(await m.getStudioRender(id)).toMatchObject({ status: "error", error: "ffmpeg boom" });
  });
  it("reports a render stuck past the function timeout as an error", async () => {
    const id = await m.createStudioRender(req);
    const r = (await m.getStudioRender(id))!;
    expect(m.effectiveStatus(r, r.createdAt + 60)).toBe("rendering");
    expect(m.effectiveStatus(r, r.createdAt + m.STALE_RENDER_SEC + 1)).toBe("error");
  });
});

describe("skusWithBeforeAfter", () => {
  it("counts live before_after rows but not cancelled ones", async () => {
    const ins = (sku: string, status: string) =>
      db.execute({
        sql: `INSERT INTO publication_queue (content_type, content_id, platform, payload, scheduled_at, status) VALUES ('before_after', ?, 'facebook', '{}', '2027-12-31 12:00:00', ?)`,
        args: [sku, status],
      });
    await ins("A", "draft");
    await ins("B", "cancelled");
    await ins("C", "published");
    expect([...(await m.skusWithBeforeAfter(["A", "B", "C", "D"]))].sort()).toEqual(["A", "C"]);
  });
});
