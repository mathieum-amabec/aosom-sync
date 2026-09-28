/** Studio API routes: admin gate, validation, and the render → queue-draft handoff. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const auth = { isAuthenticated: vi.fn(), isAdmin: vi.fn() };
vi.mock("@/lib/auth", () => auth);

const studioDb = {
  createStudioRender: vi.fn(),
  finishStudioRender: vi.fn(),
  getStudioRender: vi.fn(),
  setStudioRenderQueueId: vi.fn(),
  effectiveStatus: (r: { status: string }) => r.status,
  countAiImagesToday: vi.fn(),
  addStudioImage: vi.fn(),
};
vi.mock("@/lib/studio/db", () => studioDb);

const database = {
  addToQueue: vi.fn(),
  ensureSchema: vi.fn(),
};
vi.mock("@/lib/database", () => database);

const afterCallbacks: (() => Promise<void>)[] = [];
vi.mock("next/server", async (orig) => {
  const real = await orig<typeof import("next/server")>();
  return { ...real, after: (cb: () => Promise<void>) => afterCallbacks.push(cb) };
});

const { POST: renderPOST } = await import("@/app/api/studio/render/route");
const { POST: queuePOST } = await import("@/app/api/studio/render/[id]/queue/route");
const { POST: retouchPOST } = await import("@/app/api/studio/retouch/route");

const json = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  auth.isAuthenticated.mockResolvedValue(true);
  auth.isAdmin.mockResolvedValue(true);
});

describe("admin gate", () => {
  it("401 without a session, 403 for a non-admin", async () => {
    auth.isAuthenticated.mockResolvedValue(false);
    expect((await renderPOST(json({}))).status).toBe(401);
    auth.isAuthenticated.mockResolvedValue(true);
    auth.isAdmin.mockResolvedValue(false);
    expect((await renderPOST(json({}))).status).toBe(403);
    expect((await retouchPOST(json({}))).status).toBe(403);
    expect(studioDb.createStudioRender).not.toHaveBeenCalled();
  });
});

describe("POST /api/studio/render", () => {
  it("400s an invalid request without creating a job", async () => {
    const res = await renderPOST(json({ sku: "X" }));
    expect(res.status).toBe(400);
    expect(studioDb.createStudioRender).not.toHaveBeenCalled();
  });
  it("creates the job, answers at once and renders in after()", async () => {
    studioDb.createStudioRender.mockResolvedValue(7);
    const res = await renderPOST(
      json({
        sku: "S",
        shopifyProductId: "1",
        before: { url: "https://cdn.shopify.com/a.jpg" },
        after: { url: "https://cdn.shopify.com/b.jpg" },
        transition: "slider",
        durationSec: 6,
        format: "9:16",
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: 7 });
    expect(afterCallbacks).toHaveLength(1);
  });
});

describe("POST /api/studio/render/:id/queue", () => {
  const ready = {
    id: 7,
    sku: "S",
    status: "ready",
    videoUrl: "https://abc.public.blob.vercel-storage.com/v.mp4",
    queueId: null,
    params: { productTitle: "Produit", before: { url: "https://cdn.shopify.com/a.jpg" }, after: { url: "https://cdn.shopify.com/b.jpg" }, format: "9:16", transition: "slider" },
  };
  it("adds a before_after DRAFT with the Studio payload and remembers the queue id", async () => {
    studioDb.getStudioRender.mockResolvedValue(ready);
    database.ensureSchema.mockResolvedValue({ execute: vi.fn().mockResolvedValue({ rows: [{ price: 249.99 }] }) });
    database.addToQueue.mockResolvedValue(99);
    const res = await queuePOST(new Request("http://x", { method: "POST" }), params("7"));
    expect(res.status).toBe(200);
    const item = database.addToQueue.mock.calls[0][0];
    expect(item).toMatchObject({ contentType: "before_after", contentId: "S", platform: "facebook", status: "draft" });
    expect(JSON.parse(item.payload)).toMatchObject({ blobUrl: ready.videoUrl, price: 249.99, studio: "https://cdn.shopify.com/a.jpg", life: "https://cdn.shopify.com/b.jpg", source: "studio" });
    expect(item.scheduledAt).toMatch(/^\d{4}-12-31 12:00:00$/);
    expect(studioDb.setStudioRenderQueueId).toHaveBeenCalledWith(7, 99);
  });
  it("409s a render that isn't ready, and doesn't double-queue", async () => {
    studioDb.getStudioRender.mockResolvedValue({ ...ready, status: "rendering" });
    expect((await queuePOST(new Request("http://x", { method: "POST" }), params("7"))).status).toBe(409);
    studioDb.getStudioRender.mockResolvedValue({ ...ready, queueId: 5 });
    const res = await queuePOST(new Request("http://x", { method: "POST" }), params("7"));
    expect((await res.json()).data).toMatchObject({ queueId: 5, alreadyQueued: true });
    expect(database.addToQueue).not.toHaveBeenCalled();
  });
});

describe("POST /api/studio/retouch", () => {
  it("rejects a non-allowed image host and enforces the daily cap", async () => {
    expect((await retouchPOST(json({ sku: "S", imageUrl: "https://evil.com/a.jpg", preset: "clean" }))).status).toBe(400);
    studioDb.countAiImagesToday.mockResolvedValue(10_000);
    const res = await retouchPOST(json({ sku: "S", imageUrl: "https://cdn.shopify.com/a.jpg", preset: "clean" }));
    expect(res.status).toBe(429);
    expect(studioDb.addStudioImage).not.toHaveBeenCalled();
  });
});
