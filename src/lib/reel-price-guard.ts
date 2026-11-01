/**
 * Reel price guard. A sequential_ad Reel can carry a rabais BURNED INTO the video (e.g. "-30 %"),
 * recorded in its queue row as `metadata.badges: [{ sku, pct }]`. Prices move daily (Aosom
 * monthly prices, auto-reprice, compare-at expiry), so a Reel rendered last week can go out
 * showing a discount the store no longer gives — a misleading-price problem, not a cosmetic one.
 *
 * Twice a day this re-reads, on Shopify (Admin API, READ-ONLY), every badge of every `pending`
 * sequential_ad row due in the next HORIZON_HOURS and checks that the variant still exists, is
 * active and available, and that round((1 − price / compareAt) × 100) === pct. A row that fails
 * is set to `draft` with error `price-guard: <details>`: the publisher only drains `pending`, so
 * it is NOT published, and `draft` is outside the active-slot unique index, so the slot frees up.
 * Nothing is re-rendered and nothing is deleted — an operator decides what to do with it.
 *
 * A Shopify read that FAILS (network, throttle) never blocks a Reel: it is reported as
 * `unverified` instead, so an outage cannot empty the queue.
 *
 * The run is recorded in settings `reel_price_guard_last`, read by publish-check and the
 * morning report.
 */
import { ensureSchema, setSetting } from "./database";
import { shopifyFetch } from "./shopify-client";

export const HORIZON_HOURS = 36;
export const SETTING_KEY = "reel_price_guard_last";

export interface Badge {
  sku: string;
  pct: number;
}

export interface LiveVariant {
  sku: string;
  price: number;
  compareAt: number | null;
  availableForSale: boolean;
  /** Shopify product status, upper-case as GraphQL returns it (ACTIVE / DRAFT / ARCHIVED). */
  productStatus: string;
}

export interface GuardRow {
  id: number;
  contentId: string;
  scheduledAt: string;
  metadata: string | null;
}

export interface BlockedReel {
  id: number;
  contentId: string;
  scheduledAt: string;
  reason: string;
}

export interface ReelPriceGuardResult {
  checkedAt: string;
  dryRun: boolean;
  /** Pending sequential_ad rows in the window. */
  rows: number;
  /** Of those, rows carrying at least one badge (the only ones checked). */
  checked: number;
  ok: number;
  blocked: BlockedReel[];
  /** Rows whose badges could not be read on Shopify (left untouched). */
  unverified: Array<{ id: number; contentId: string; reason: string }>;
}

/** Badges of a queue row, or [] when it has none / metadata is malformed. */
export function parseBadges(metadata: string | null): Badge[] {
  if (!metadata) return [];
  try {
    const m = JSON.parse(metadata) as { badges?: unknown };
    if (!Array.isArray(m.badges)) return [];
    return m.badges
      .filter((b): b is { sku: unknown; pct: unknown } => !!b && typeof b === "object")
      .map((b) => ({ sku: String(b.sku ?? "").trim(), pct: Number(b.pct) }))
      .filter((b) => b.sku.length > 0 && Number.isFinite(b.pct));
  } catch {
    return [];
  }
}

export function livePct(v: Pick<LiveVariant, "price" | "compareAt">): number {
  if (v.compareAt == null || !(v.compareAt > v.price) || !(v.compareAt > 0)) return 0;
  return Math.round((1 - v.price / v.compareAt) * 100);
}

const money = (n: number) => `${n.toFixed(2).replace(".", ",")} $`;

/** Why a badge no longer matches the store, or null when it still does. */
export function badgeProblem(badge: Badge, v: LiveVariant | null): string | null {
  if (!v) return `${badge.sku}: variante introuvable sur Shopify`;
  if (v.productStatus !== "ACTIVE") return `${badge.sku}: produit ${v.productStatus.toLowerCase()} sur Shopify`;
  if (!v.availableForSale) return `${badge.sku}: plus en vente`;
  const live = livePct(v);
  if (live !== Math.round(badge.pct)) {
    const shown = v.compareAt != null && v.compareAt > v.price ? ` (${money(v.price)} au lieu de ${money(v.compareAt)})` : ` (${money(v.price)}, aucun prix barré)`;
    return `${badge.sku}: la vidéo affiche -${badge.pct} %, Shopify donne -${live} %${shown}`;
  }
  return null;
}

/** Read one variant by exact SKU (Admin GraphQL, read-only). Null when no variant has that SKU. */
export async function fetchVariantBySku(sku: string): Promise<LiveVariant | null> {
  const query = `query($q: String!) { productVariants(first: 10, query: $q) { nodes { sku price compareAtPrice availableForSale product { status } } } }`;
  const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query, variables: { q: `sku:"${sku.replace(/"/g, "")}"` } }) });
  if (!res.ok) throw new Error(`Shopify ${res.status}`);
  const j = (await res.json()) as {
    errors?: unknown;
    data?: { productVariants?: { nodes?: Array<{ sku: string | null; price: string; compareAtPrice: string | null; availableForSale: boolean; product?: { status?: string } }> } };
  };
  if (j.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(j.errors).slice(0, 200)}`);
  const node = (j.data?.productVariants?.nodes ?? []).find((n) => (n.sku ?? "").trim().toLowerCase() === sku.trim().toLowerCase());
  if (!node) return null;
  return {
    sku: node.sku ?? sku,
    price: Number(node.price),
    compareAt: node.compareAtPrice == null ? null : Number(node.compareAtPrice),
    availableForSale: !!node.availableForSale,
    productStatus: String(node.product?.status ?? "UNKNOWN").toUpperCase(),
  };
}

export interface GuardDeps {
  loadRows: () => Promise<GuardRow[]>;
  fetchVariant: (sku: string) => Promise<LiveVariant | null>;
  /** Moves ONE row from pending to draft; returns false when it was no longer pending (race). */
  blockRow: (id: number, error: string) => Promise<boolean>;
  saveResult: (r: ReelPriceGuardResult) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: GuardDeps = {
  loadRows: async () => {
    const db = await ensureSchema();
    const r = await db.execute({
      sql: `SELECT id, content_id, scheduled_at, metadata FROM publication_queue
            WHERE status = 'pending' AND content_type = 'sequential_ad'
              AND scheduled_at >= datetime('now', '-1 hour') AND scheduled_at <= datetime('now', ?)
            ORDER BY scheduled_at, id`,
      args: [`+${HORIZON_HOURS} hours`],
    });
    return r.rows.map((row) => {
      const o = row as unknown as Record<string, unknown>;
      return { id: Number(o.id), contentId: String(o.content_id), scheduledAt: String(o.scheduled_at), metadata: o.metadata == null ? null : String(o.metadata) };
    });
  },
  fetchVariant: fetchVariantBySku,
  blockRow: async (id, error) => {
    const db = await ensureSchema();
    const r = await db.execute({ sql: `UPDATE publication_queue SET status = 'draft', error = ? WHERE id = ? AND status = 'pending'`, args: [error, id] });
    return r.rowsAffected > 0;
  },
  saveResult: (r) => setSetting(SETTING_KEY, JSON.stringify(r)),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Shopify allows ~2 req/s on this store: space the reads. */
const READ_SPACING_MS = 500;

export async function runReelPriceGuard(opts: { dryRun?: boolean; now?: Date } = {}, deps: GuardDeps = defaultDeps): Promise<ReelPriceGuardResult> {
  const now = opts.now ?? new Date();
  const dryRun = !!opts.dryRun;
  const rows = await deps.loadRows();
  const cache = new Map<string, Promise<LiveVariant | null>>();
  const read = (sku: string) => {
    const key = sku.toLowerCase();
    if (!cache.has(key)) cache.set(key, (async () => {
      if (cache.size > 1) await deps.sleep(READ_SPACING_MS);
      return deps.fetchVariant(sku);
    })());
    return cache.get(key)!;
  };

  const result: ReelPriceGuardResult = { checkedAt: now.toISOString(), dryRun, rows: rows.length, checked: 0, ok: 0, blocked: [], unverified: [] };
  for (const row of rows) {
    const badges = parseBadges(row.metadata);
    if (badges.length === 0) continue;
    result.checked++;
    const problems: string[] = [];
    let unreadable: string | null = null;
    for (const b of badges) {
      try {
        const p = badgeProblem(b, await read(b.sku));
        if (p) problems.push(p);
      } catch (err) {
        unreadable = `${b.sku}: lecture Shopify impossible (${err instanceof Error ? err.message : String(err)})`.slice(0, 200);
      }
    }
    if (problems.length > 0) {
      const reason = problems.join(" · ");
      const blocked = dryRun ? true : await deps.blockRow(row.id, `price-guard: ${reason}`.slice(0, 1000));
      if (blocked) result.blocked.push({ id: row.id, contentId: row.contentId, scheduledAt: row.scheduledAt, reason });
    } else if (unreadable) {
      result.unverified.push({ id: row.id, contentId: row.contentId, reason: unreadable });
    } else {
      result.ok++;
    }
  }
  if (!dryRun) await deps.saveResult(result);
  return result;
}
