/** Persistence for the Studio Avant/Après (tables studio_images + studio_renders, DDL in database.ts). */
import { ensureSchema } from "@/lib/database";
import type { StudioRenderRequest } from "./options";

export interface StudioImage {
  id: number;
  sku: string;
  url: string;
  source: "upload" | "ai";
  parentUrl: string | null;
  prompt: string | null;
  createdAt: number;
}

const toImage = (r: Record<string, unknown>): StudioImage => ({
  id: Number(r.id),
  sku: String(r.sku),
  url: String(r.url),
  source: r.source === "ai" ? "ai" : "upload",
  parentUrl: r.parent_url == null ? null : String(r.parent_url),
  prompt: r.prompt == null ? null : String(r.prompt),
  createdAt: Number(r.created_at),
});

export async function addStudioImage(img: { sku: string; url: string; source: "upload" | "ai"; parentUrl?: string | null; prompt?: string | null }): Promise<StudioImage> {
  const db = await ensureSchema();
  const res = await db.execute({
    sql: `INSERT INTO studio_images (sku, url, source, parent_url, prompt) VALUES (?, ?, ?, ?, ?) RETURNING *`,
    args: [img.sku, img.url, img.source, img.parentUrl ?? null, img.prompt ?? null],
  });
  return toImage(res.rows[0] as unknown as Record<string, unknown>);
}

export async function listStudioImages(sku: string): Promise<StudioImage[]> {
  const db = await ensureSchema();
  const res = await db.execute({ sql: `SELECT * FROM studio_images WHERE sku = ? ORDER BY id DESC`, args: [sku] });
  return res.rows.map((r) => toImage(r as unknown as Record<string, unknown>));
}

export async function getStudioImage(id: number): Promise<StudioImage | null> {
  const db = await ensureSchema();
  const res = await db.execute({ sql: `SELECT * FROM studio_images WHERE id = ?`, args: [id] });
  return res.rows[0] ? toImage(res.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function deleteStudioImage(id: number): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `DELETE FROM studio_images WHERE id = ?`, args: [id] });
}

/** AI retouches created since the start of the current UTC day (daily cost cap). */
export async function countAiImagesToday(): Promise<number> {
  const db = await ensureSchema();
  const res = await db.execute(
    `SELECT COUNT(*) AS n FROM studio_images WHERE source = 'ai' AND created_at >= strftime('%s', date('now'))`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

export interface StudioRender {
  id: number;
  sku: string;
  productTitle: string | null;
  params: StudioRenderRequest;
  status: "rendering" | "ready" | "error";
  videoUrl: string | null;
  error: string | null;
  queueId: number | null;
  createdAt: number;
  updatedAt: number;
}

const toRender = (r: Record<string, unknown>): StudioRender => ({
  id: Number(r.id),
  sku: String(r.sku),
  productTitle: r.product_title == null ? null : String(r.product_title),
  params: JSON.parse(String(r.params)) as StudioRenderRequest,
  status: (["rendering", "ready", "error"].includes(String(r.status)) ? r.status : "error") as StudioRender["status"],
  videoUrl: r.video_url == null ? null : String(r.video_url),
  error: r.error == null ? null : String(r.error),
  queueId: r.queue_id == null ? null : Number(r.queue_id),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

export async function createStudioRender(req: StudioRenderRequest): Promise<number> {
  const db = await ensureSchema();
  const res = await db.execute({
    sql: `INSERT INTO studio_renders (sku, product_title, params, status) VALUES (?, ?, ?, 'rendering') RETURNING id`,
    args: [req.sku, req.productTitle, JSON.stringify(req)],
  });
  return Number(res.rows[0].id);
}

export async function finishStudioRender(id: number, result: { videoUrl: string } | { error: string }): Promise<void> {
  const db = await ensureSchema();
  if ("videoUrl" in result) {
    await db.execute({
      sql: `UPDATE studio_renders SET status = 'ready', video_url = ?, error = NULL, updated_at = strftime('%s','now') WHERE id = ?`,
      args: [result.videoUrl, id],
    });
  } else {
    await db.execute({
      sql: `UPDATE studio_renders SET status = 'error', error = ?, updated_at = strftime('%s','now') WHERE id = ?`,
      args: [result.error.slice(0, 1000), id],
    });
  }
}

export async function setStudioRenderQueueId(id: number, queueId: number): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE studio_renders SET queue_id = ?, updated_at = strftime('%s','now') WHERE id = ?`, args: [queueId, id] });
}

export async function getStudioRender(id: number): Promise<StudioRender | null> {
  const db = await ensureSchema();
  const res = await db.execute({ sql: `SELECT * FROM studio_renders WHERE id = ?`, args: [id] });
  return res.rows[0] ? toRender(res.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function listStudioRenders(sku: string, limit = 20): Promise<StudioRender[]> {
  const db = await ensureSchema();
  const res = await db.execute({ sql: `SELECT * FROM studio_renders WHERE sku = ? ORDER BY id DESC LIMIT ?`, args: [sku, limit] });
  return res.rows.map((r) => toRender(r as unknown as Record<string, unknown>));
}

/**
 * A render left in 'rendering' past the function's max duration died with its instance
 * (Vercel killed it mid-ffmpeg); report it as an error instead of polling forever.
 */
export const STALE_RENDER_SEC = 330;
export function effectiveStatus(r: StudioRender, nowSec = Math.floor(Date.now() / 1000)): StudioRender["status"] {
  return r.status === "rendering" && nowSec - r.createdAt > STALE_RENDER_SEC ? "error" : r.status;
}

/** SKUs that already have a before/after video (queued, pending or published — not cancelled). */
export async function skusWithBeforeAfter(skus: string[]): Promise<Set<string>> {
  if (!skus.length) return new Set();
  const db = await ensureSchema();
  const ph = skus.map(() => "?").join(",");
  const res = await db.execute({
    sql: `SELECT DISTINCT content_id FROM publication_queue
           WHERE content_type = 'before_after' AND status NOT IN ('cancelled', 'failed') AND content_id IN (${ph})`,
    args: skus,
  });
  return new Set(res.rows.map((r) => String(r.content_id)));
}
