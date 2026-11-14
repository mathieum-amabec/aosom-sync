/**
 * The REAL state of an import job — what the operator actually needs to know.
 *
 * `import_jobs.status` only records how far the import queue got. It drifts from reality:
 * products imported by scripts (mass-import, pilot-import) leave their job at "pending", a
 * product deleted and re-created on Shopify leaves the job pointing at a dead id, and a
 * product drafted by the stale-catalog guard still reads "done". On 2026-09-30 all 91
 * "pending" jobs were in fact already on Shopify (72 live).
 *
 * This module derives, from three sources, a state the import page can trust:
 *   - Shopify: does the product exist, is it live, hidden (draft / unpublished) or archived?
 *   - Aosom feed (`products` table): is the SKU still in the feed, and in stock?
 *   - The job itself: status + error.
 *
 * Pure functions only (no I/O) — the loaders live in import-job-state-service.ts.
 */

/** Shopify-side state of one product, as returned by fetchAllProductStates. */
export interface ShopifyProductState {
  status: "active" | "draft" | "archived";
  /** Published on the Online Store (publishedAt set and not in the future). */
  published: boolean;
  tags: string[];
}

/** One `products` row for a SKU of the job. */
export interface FeedRow {
  sku: string;
  qty: number;
  /** Unix seconds — last time the daily sync saw the SKU in the Aosom CSV. */
  lastSeenAt: number | null;
  shopifyProductId: string | null;
}

export interface JobInput {
  status: string;
  shopifyId: string | null;
  error: string | null;
  skus: string[];
}

export type ShopifyPresence = "live" | "hidden" | "archived" | "deleted" | "not_created";
export type FeedPresence = "in_stock" | "out_of_stock" | "gone" | "unknown";
/** The tab a job lands in on the import page. */
export type ImportBucket = "to_import" | "live" | "hidden_in_stock" | "hidden_intentional" | "problem";

export interface ImportJobState {
  /** The Shopify product this job really maps to (job id if it still exists, else the SKU's current product). */
  shopifyId: string | null;
  shopify: ShopifyPresence;
  feed: FeedPresence;
  bucket: ImportBucket;
  /** One plain-French line explaining the bucket. */
  reason: string;
}

/**
 * A SKU counts as "in the feed" when the daily sync saw it within this window. The sync
 * runs once a day (06:00 UTC, retried 06:30); 2 days tolerates one failed sync without
 * flagging the whole catalogue as gone.
 */
export const FEED_FRESH_SECS = 2 * 86400;

/** Tags that mark a draft as intentional (aosom-sync drafted it, or the operator excluded it). */
const INTENTIONAL_DRAFT_TAGS = ["auto-drafted", "exclude-stale"];

export function feedPresence(rows: FeedRow[], nowSecs: number): FeedPresence {
  if (rows.length === 0) return "unknown";
  const fresh = rows.filter((r) => r.lastSeenAt != null && r.lastSeenAt >= nowSecs - FEED_FRESH_SECS);
  if (fresh.length === 0) return "gone";
  return fresh.some((r) => r.qty > 0) ? "in_stock" : "out_of_stock";
}

/**
 * Which Shopify product the job really maps to. The job's own id wins while it still exists;
 * otherwise the id the SKUs carry today (re-imported under a new product). Null = nothing on Shopify.
 */
export function resolveShopifyId(
  job: Pick<JobInput, "shopifyId">,
  rows: FeedRow[],
  states: ReadonlyMap<string, ShopifyProductState>,
): string | null {
  if (job.shopifyId && states.has(job.shopifyId)) return job.shopifyId;
  const current = rows.map((r) => r.shopifyProductId).find((id): id is string => !!id && states.has(id));
  return current ?? null;
}

function shopifyPresence(id: string | null, job: JobInput, states: ReadonlyMap<string, ShopifyProductState>): ShopifyPresence {
  if (id) {
    const s = states.get(id)!;
    if (s.status === "archived") return "archived";
    if (s.status === "active" && s.published) return "live";
    return "hidden";
  }
  // No live mapping: the job pointed at a product that no longer exists → deleted;
  // it never had one → not created yet.
  return job.shopifyId ? "deleted" : "not_created";
}

export function classifyImportJob(
  job: JobInput,
  rows: FeedRow[],
  states: ReadonlyMap<string, ShopifyProductState>,
  nowSecs: number,
): ImportJobState {
  const shopifyId = resolveShopifyId(job, rows, states);
  const shopify = shopifyPresence(shopifyId, job, states);
  const feed = feedPresence(rows, nowSecs);
  const base = { shopifyId, shopify, feed };

  if (job.status === "needs_review") {
    return { ...base, bucket: "problem", reason: `Contrôle qualité échoué — ${job.error ?? "à vérifier"}` };
  }

  switch (shopify) {
    case "live":
      if (feed === "gone") return { ...base, bucket: "problem", reason: "En ligne, mais retiré du flux Aosom" };
      if (feed === "out_of_stock") return { ...base, bucket: "live", reason: "En ligne — en rupture chez Aosom" };
      return { ...base, bucket: "live", reason: "En ligne" };
    case "hidden": {
      const tags = states.get(shopifyId!)!.tags.map((t) => t.toLowerCase());
      if (tags.some((t) => INTENTIONAL_DRAFT_TAGS.includes(t))) {
        return { ...base, bucket: "hidden_intentional", reason: "Masqué volontairement (tag auto-drafted / exclude-stale)" };
      }
      if (feed === "in_stock") return { ...base, bucket: "hidden_in_stock", reason: "Masqué, mais en stock chez Aosom — à republier" };
      if (feed === "gone") return { ...base, bucket: "hidden_intentional", reason: "Masqué — retiré du flux Aosom" };
      if (feed === "out_of_stock") return { ...base, bucket: "hidden_intentional", reason: "Masqué — en rupture chez Aosom" };
      return { ...base, bucket: "hidden_intentional", reason: "Masqué" };
    }
    case "archived":
      return { ...base, bucket: "hidden_intentional", reason: "Archivé sur Shopify" };
    case "deleted":
      return { ...base, bucket: "problem", reason: "Le produit Shopify de ce job a été supprimé" };
    case "not_created":
      if (job.status === "error") return { ...base, bucket: "problem", reason: job.error ?? "Erreur sans détail" };
      if (feed === "gone") return { ...base, bucket: "problem", reason: "Plus dans le flux Aosom — impossible à importer" };
      if (feed === "out_of_stock") return { ...base, bucket: "to_import", reason: "Pas encore importé — en rupture chez Aosom" };
      return { ...base, bucket: "to_import", reason: "Pas encore importé" };
  }
}

/** A one-off correction of an import_jobs row so its status matches reality. */
export interface ImportJobFix {
  jobId: string;
  from: { status: string; shopifyId: string | null };
  set: { status?: string; shopify_id?: string | null; error?: null };
  why: string;
}

/** Statuses that mean "the queue never finished" — wrong when the product already exists. */
const UNFINISHED = new Set(["pending", "generating", "reviewing", "importing", "error"]);

/**
 * The corrections that make import_jobs agree with Shopify. Never touches `needs_review`
 * (a quality-gate verdict the operator must see) and never creates or deletes anything
 * on Shopify — it only rewrites the queue's bookkeeping.
 */
export function planImportJobFix(jobId: string, job: JobInput, state: ImportJobState): ImportJobFix | null {
  const from = { status: job.status, shopifyId: job.shopifyId };
  if (job.status === "needs_review") return null;

  if (state.shopifyId) {
    const relink = state.shopifyId !== job.shopifyId;
    const finish = UNFINISHED.has(job.status);
    if (!relink && !finish) return null;
    const set: ImportJobFix["set"] = {};
    if (finish) { set.status = "done"; set.error = null; }
    if (relink) set.shopify_id = state.shopifyId;
    const why = [
      finish ? `déjà sur Shopify (${state.shopify}) → done` : null,
      relink ? (job.shopifyId ? `ancien produit ${job.shopifyId} supprimé → relié à ${state.shopifyId}` : `relié à ${state.shopifyId}`) : null,
    ].filter(Boolean).join(" ; ");
    return { jobId, from, set, why };
  }

  if (job.shopifyId) {
    // Pointed at a deleted product and nothing replaced it: the product is genuinely not
    // on Shopify, so the job goes back to "pending" (it keeps its generated content).
    return { jobId, from, set: { status: "pending", shopify_id: null, error: null }, why: `produit ${job.shopifyId} supprimé, rien d'autre sur Shopify → pending` };
  }
  return null;
}
