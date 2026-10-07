/**
 * "La semaine Ameublo" — fully automated Facebook/Instagram photo posts, two a day per brand.
 *
 * Morning slot (10:00 Toronto): one themed format per weekday. Afternoon slot (15:00): one
 * featured product. Every post is built from LIVE facts (Shopify price/status/photo, catalog
 * stock) and every number a customer sees (price, discount, link) is written by code, never by
 * the model — the model only writes the hook and the lines around those facts.
 */

export type SlotName = "morning" | "afternoon";

export type FormatId =
  | "nouveautes" // Mon — new arrivals roundup (multi-photo)
  | "baisses" //    Tue — real price drops (multi-photo)
  | "piece" //      Wed — a complete room, 4 complementary pieces (multi-photo)
  | "ab" //         Thu — A or B (2 photos, asks for a vote in the comments)
  | "top-ventes" // Fri — the week's best sellers (multi-photo)
  | "astuce" //     Sat — a measuring rule + the product it applies to
  | "coeur" //      Sun — one product, emotional
  | "vedette"; //   afternoon, every day — one featured product

/** A catalog row that MAY be postable; nothing is trusted until `verifyProduct` passes. */
export interface Candidate {
  sku: string;
  shopifyProductId: string;
  /** products.name — the raw English supplier title (never shown as-is). */
  nameEn: string;
  productType: string;
  stock: number;
  velocity: number;
}

/** A candidate that passed every live gate: active, in stock, verified photo, real price. */
export interface LiveProduct {
  sku: string;
  shopifyProductId: string;
  titleFr: string;
  /** Short English display title (supplier brands stripped, cut at the first clause). */
  titleEn: string;
  price: number;
  /** Live Shopify compare-at when it is a real ≥10 % rabais, else null. */
  compareAt: number | null;
  handle: string;
  /** Clean Shopify-CDN position-1 lifestyle photo, posted raw. */
  imageUrl: string;
  productType: string;
}

export interface PlannedPost {
  format: FormatId;
  /** Short label used in logs / notifications, e.g. "Nouveautés de la semaine". */
  label: string;
  products: LiveProduct[];
  /** Extra, code-owned facts the caption may mention (e.g. the room, the measuring rule). */
  topic?: { fr: string; en: string };
  /** Hard cap for how many products a post carries. */
  maxProducts: number;
}

export interface BuiltCaptions {
  fr: string;
  en: string;
}

export type RunStatus = "queued" | "skipped" | "failed" | "dry_run";

export interface RunResult {
  status: RunStatus;
  localDate: string;
  slot: SlotName;
  format?: FormatId;
  skus?: string[];
  reason?: string;
  queueIds?: number[];
  scheduledAt?: string;
  captions?: BuiltCaptions;
  imageUrls?: string[];
}
