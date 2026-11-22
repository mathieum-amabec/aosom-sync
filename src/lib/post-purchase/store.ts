/** Turso access for the offre de remerciement: the nightly candidate catalogue and the per-order offers. */
import { ensureSchema, getSetting, setSetting } from "@/lib/database";
import type { MerciCandidate } from "./offer-rules";

export const CATALOG_GEN_KEY = "merci_catalog_gen";

/** Write a whole new catalogue generation, point readers at it, then drop older generations. */
export async function replaceCandidates(rows: MerciCandidate[], gen = Date.now()): Promise<number> {
  const db = await ensureSchema();
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.batch(
      rows.slice(i, i + CHUNK).map((c) => ({
        sql: `INSERT OR REPLACE INTO merci_candidates (gen, variant_id, product_id, handle, title, type, colour, price, compare_at, cost, image_url, pct)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [gen, c.variantId, c.productId, c.handle, c.title, c.type, c.colour, c.price, c.compareAt, c.cost, c.imageUrl, c.pct],
      })),
      "write",
    );
  }
  await setSetting(CATALOG_GEN_KEY, String(gen));
  await db.execute({ sql: `DELETE FROM merci_candidates WHERE gen <> ?`, args: [gen] });
  return rows.length;
}

export async function loadCandidates(): Promise<MerciCandidate[]> {
  const gen = await getSetting(CATALOG_GEN_KEY);
  if (!gen) return [];
  const db = await ensureSchema();
  const r = await db.execute({ sql: `SELECT * FROM merci_candidates WHERE gen = ?`, args: [Number(gen)] });
  return r.rows.map((row) => ({
    variantId: String(row.variant_id),
    productId: String(row.product_id),
    handle: String(row.handle),
    title: String(row.title),
    type: String(row.type),
    colour: row.colour == null ? null : String(row.colour),
    price: Number(row.price),
    compareAt: row.compare_at == null ? null : Number(row.compare_at),
    cost: Number(row.cost),
    imageUrl: String(row.image_url),
    pct: Number(row.pct),
  }));
}

/** Colour of a product in the catalogue (used for the anchor's colour family). */
export async function catalogueColour(productId: string): Promise<string | null> {
  const gen = await getSetting(CATALOG_GEN_KEY);
  if (!gen) return null;
  const db = await ensureSchema();
  const r = await db.execute({ sql: `SELECT colour FROM merci_candidates WHERE gen = ? AND product_id = ? AND colour IS NOT NULL LIMIT 1`, args: [Number(gen), productId] });
  return r.rows[0]?.colour == null ? null : String(r.rows[0].colour);
}

// ─── Per-order offers ─────────────────────────────────────────────────────

export interface StoredOffer {
  title: string;
  imageUrl: string;
  handle: string;
  variantId: string;
  price: number;
  compareAt: number | null;
  discountedPrice: number;
  pct: number;
  why: string;
  code: string;
  discountId: string;
}

export interface OfferRow {
  order_id: string;
  order_name: string | null;
  status: "pending" | "ready" | "none";
  offers: StoredOffer[];
  expires_at: number | null;
  created_at: number;
}

export async function getOfferRow(orderId: string): Promise<OfferRow | null> {
  const db = await ensureSchema();
  const r = await db.execute({ sql: `SELECT * FROM post_purchase_offers WHERE order_id = ?`, args: [orderId] });
  const row = r.rows[0];
  if (!row) return null;
  let offers: StoredOffer[] = [];
  try {
    offers = row.offers ? (JSON.parse(String(row.offers)) as StoredOffer[]) : [];
  } catch {
    offers = [];
  }
  return {
    order_id: String(row.order_id),
    order_name: row.order_name == null ? null : String(row.order_name),
    status: String(row.status) as OfferRow["status"],
    offers,
    expires_at: row.expires_at == null ? null : Number(row.expires_at),
    created_at: Number(row.created_at),
  };
}

/** Reserve the order's only offer. False when a row already exists (the caller reads it back). */
export async function reserveOffer(orderId: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `INSERT INTO post_purchase_offers (order_id, status, created_at) VALUES (?, 'pending', ?) ON CONFLICT(order_id) DO NOTHING`,
    args: [orderId, nowSec],
  });
  return r.rowsAffected === 1;
}

/** Take over a crashed reservation (still 'pending' and older than `staleSec`). True when we got it. */
export async function takeStaleReservation(orderId: string, staleSec: number, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `UPDATE post_purchase_offers SET created_at = ? WHERE order_id = ? AND status = 'pending' AND created_at < ?`,
    args: [nowSec, orderId, nowSec - staleSec],
  });
  return r.rowsAffected === 1;
}

export async function finishOffer(orderId: string, v: { orderName: string | null; status: "ready" | "none"; offers: StoredOffer[]; expiresAt: number | null }): Promise<void> {
  const db = await ensureSchema();
  await db.execute({
    sql: `UPDATE post_purchase_offers SET order_name = ?, status = ?, offers = ?, expires_at = ? WHERE order_id = ?`,
    args: [v.orderName, v.status, JSON.stringify(v.offers), v.expiresAt, orderId],
  });
}

/** Undo a reservation whose codes could not be created, so a retry can try again. */
export async function releaseOffer(orderId: string): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `DELETE FROM post_purchase_offers WHERE order_id = ? AND status = 'pending'`, args: [orderId] });
}
