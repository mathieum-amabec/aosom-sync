/**
 * Neutral identity for Costway products sold on Ameublo Direct.
 *
 * Same rule as Aosom: the store sells under its OWN titles, handles and SKUs, and the supplier is
 * never exposed. Concretely, nothing below may reach Shopify, a product feed, an ad or an image URL:
 *   - the supplier SKU ("02956471_CB10061BK") and its numeric item number — they identify the item
 *     in Costway's own catalogue and storefront;
 *   - the feed's handle / product URL (costway.ca/...), which are the supplier's slugs;
 *   - the word "Costway" anywhere customer-visible (709 of the 22,670 feed bodies mention it).
 *
 * Pure helpers live here; the one DB-touching function is `assignInternalSkus`.
 */
import { createHash } from "node:crypto";
import { ensureSchema } from "@/lib/database";
import { stripSupplierBrands, forbiddenBrandsIn } from "@/lib/catalog-guard";

// Crockford base32: no I, L, O, U — nothing that reads as a word or gets misread over the phone.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Fixed first character: keeps the SKU from ever reading as a bare number or a supplier item number. */
const SKU_PREFIX = "M";
const SKU_BODY_LEN = 7;

/** One deterministic candidate for (costwaySku, attempt). 7 base32 chars = 35 bits. */
function candidate(costwaySku: string, attempt: number): string {
  const digest = createHash("sha256").update(`ameublo-direct|costway|${costwaySku}|${attempt}`).digest();
  let out = "";
  for (let i = 0; i < SKU_BODY_LEN; i++) out += ALPHABET[digest[i] & 31];
  return SKU_PREFIX + out;
}

/**
 * The Ameublo SKU for a Costway variant: stable (same input → same output while no collision),
 * opaque (no part of the supplier SKU survives), and unique against `isTaken` — which must cover
 * BOTH the Costway internal SKUs and the Aosom `products.sku` space. On the (rare, ~0.7% across all
 * 22k variants) collision it re-hashes with a counter instead of failing.
 */
export function internalSkuFor(costwaySku: string, isTaken: (sku: string) => boolean): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const sku = candidate(costwaySku, attempt);
    if (!isTaken(sku)) return sku;
  }
  throw new Error(`internalSkuFor: no free SKU for ${costwaySku} after 1000 attempts`);
}

/** True for a string shaped like one of our internal Costway SKUs (M + 7 base32). */
export function isInternalSku(s: string): boolean {
  return new RegExp(`^${SKU_PREFIX}[${ALPHABET}]{${SKU_BODY_LEN}}$`).test(s);
}

/**
 * A neutral image filename for a variant's Nth image ("m7h3k9q2-1.jpg"). Shopify keeps the SOURCE
 * filename in the CDN URL it serves, and Costway's files are named after the supplier's own model
 * numbers ("cb10061bk.jpg") — so images are uploaded under this name instead of ingested by URL.
 */
export function neutralImageFilename(internalSku: string, index: number, sourceUrl: string): string {
  const ext = (sourceUrl.split("?")[0].match(/\.(jpe?g|png|webp|gif)$/i)?.[1] ?? "jpg").toLowerCase();
  return `${internalSku.toLowerCase()}-${index + 1}.${ext === "jpeg" ? "jpg" : ext}`;
}

/**
 * Where the supplier shows through in a piece of customer-facing text: the brand name (any case,
 * its domain), its item number, or its SKU pattern. Empty = clean. Use as a pre-publish gate on
 * every text field of a product (titles, body, handle, tags, alt text, metafields).
 */
export function findCostwayLeaks(text: string | null | undefined, costwaySkus: string[] = []): string[] {
  if (!text) return [];
  const leaks = forbiddenBrandsIn(text).filter((b) => b.toLowerCase() === "costway");
  if (/costway\.(?:ca|com)|assets\.costway/i.test(text)) leaks.push("costway domain");
  for (const sku of costwaySkus) {
    if (sku && text.toLowerCase().includes(sku.toLowerCase())) leaks.push(`supplier SKU ${sku}`);
    const item = sku.split("_")[0];
    if (item && /^\d{6,}$/.test(item) && new RegExp(`(?<!\\d)${item}(?!\\d)`).test(text)) leaks.push(`supplier item no. ${item}`);
  }
  return [...new Set(leaks)];
}

/** Brand-strip a free-text field (title, tag, handle candidate) — Costway is on the shared list. */
export const stripCostway = stripSupplierBrands;

/**
 * Give every given Costway variant its internal SKU (idempotent: variants that already have one
 * keep it). Only the variants being IMPORTED are assigned — not all ~22k feed rows — so a Costway
 * row that is never imported costs no write. Uniqueness is enforced by the DB (unique partial
 * index); a lost race simply re-hashes. Returns costwaySku → internalSku for every input SKU that
 * exists in `costway_products`.
 */
export async function assignInternalSkus(costwaySkus: string[]): Promise<Map<string, string>> {
  const db = await ensureSchema();
  const result = new Map<string, string>();
  const unique = [...new Set(costwaySkus)];

  for (let i = 0; i < unique.length; i += 400) {
    const chunk = unique.slice(i, i + 400);
    const marks = chunk.map(() => "?").join(",");
    const rows = (await db.execute({ sql: `SELECT sku, internal_sku FROM costway_products WHERE sku IN (${marks})`, args: chunk })).rows;
    for (const r of rows) {
      const row = r as unknown as { sku: string; internal_sku: string | null };
      if (row.internal_sku) result.set(row.sku, row.internal_sku);
    }
    for (const sku of chunk) {
      if (result.has(sku) || !rows.some((r) => (r as unknown as { sku: string }).sku === sku)) continue;
      for (let tries = 0; tries < 20; tries++) {
        const taken = await takenSkus(db, sku);
        const chosen = internalSkuFor(sku, (c) => taken.has(c));
        try {
          const res = await db.execute({
            sql: `UPDATE costway_products SET internal_sku = ? WHERE sku = ? AND internal_sku IS NULL`,
            args: [chosen, sku],
          });
          if (res.rowsAffected === 0) {
            // Someone else assigned it first — read theirs.
            const cur = (await db.execute({ sql: `SELECT internal_sku FROM costway_products WHERE sku = ?`, args: [sku] })).rows[0] as unknown as { internal_sku: string | null } | undefined;
            if (cur?.internal_sku) result.set(sku, cur.internal_sku);
          } else {
            result.set(sku, chosen);
          }
          break;
        } catch (err) {
          // Unique-index violation = the candidate was taken between our check and the write: retry.
          if (!/UNIQUE|constraint/i.test(String(err)) || tries === 19) throw err;
        }
      }
    }
  }
  return result;
}

/** Candidate SKUs already in use for this variant's hash neighbourhood, across BOTH SKU spaces. */
async function takenSkus(db: Awaited<ReturnType<typeof ensureSchema>>, costwaySku: string): Promise<Set<string>> {
  const cands = Array.from({ length: 12 }, (_, n) => candidate(costwaySku, n));
  const marks = cands.map(() => "?").join(",");
  const [cw, aosom] = await Promise.all([
    db.execute({ sql: `SELECT internal_sku AS s FROM costway_products WHERE internal_sku IN (${marks})`, args: cands }),
    db.execute({ sql: `SELECT sku AS s FROM products WHERE sku IN (${marks})`, args: cands }),
  ]);
  return new Set([...cw.rows, ...aosom.rows].map((r) => String((r as unknown as { s: string }).s)));
}
