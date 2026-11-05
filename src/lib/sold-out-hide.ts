/**
 * Sold-out hide — take a product OFF SALE when nothing in it can be sold, and bring it back by
 * itself when stock returns. Also hides seasonal products (Halloween) outside their season.
 *
 * Why: the intraday stock-check only TAGS a sold-out product (`out-of-stock`) and leaves it
 * active, and most Aosom variants are untracked (`inventory_management: null`), so a sold-out
 * product stayed live, buyable and featured in collections, the homepage carousel and the ad
 * feeds. Mat (2026-11-04): « retire les produits en rupture dont l'Halloween ».
 *
 * HOW a product is taken off sale: status DRAFT. Draft hides it from EVERY sales channel (Online
 * Store, collections, search, Facebook/Instagram, Google) while keeping the product, its handle,
 * its photos, its reviews and its publications, so bringing it back is one status flip. We never
 * archive or delete (that would lose the URL and the channel publications).
 *
 * Two markers, both tags, so the decision is visible in the Shopify admin:
 *   - `auto-drafted` (STOCK_TAG_AUTODRAFTED) — sold out. It is the SAME marker the stock-check
 *     cron already uses, so stock-check's existing reactivation path also brings these back on
 *     restock, and publish-reconcile already refuses to republish them.
 *   - `hors-saison` (SEASON_TAG) — out of season. Deliberately WITHOUT `auto-drafted`, so the
 *     stock-check reactivation (which only looks at `auto-drafted`) never republishes an in-stock
 *     Halloween product in November. Only this job lifts it, once the season starts. It is the
 *     job's OWN marker: only this job adds it, and only to a product it drafted itself (ACTIVE →
 *     DRAFT) or to an automatic `auto-drafted` draft, never to an operator's draft.
 *
 * Keep a seasonal product live out of season: tag it `exclude-stale` (the operator pin).
 *
 * Decision rule per product (pure, `planSoldOutHide`):
 *   ACTIVE product
 *     - `exclude-stale` (operator pin) or in an open order        → leave alone
 *     - seasonal and out of season                                → DRAFT + `hors-saison`
 *     - ≥1 variant present in today's feed AND no variant sellable → DRAFT + `auto-drafted`
 *       (a product ENTIRELY absent from the feed is left to removed-catalog / stale-catalog,
 *        which know about Aosom SKU renames — this job must not draft a renamed product)
 *   DRAFT product
 *     - `hors-saison`, now in season (or no longer seasonal): sellable → ACTIVE (+ publish),
 *       not sellable → swap `hors-saison` for `auto-drafted` (it comes back on restock)
 *     - seasonal, out of season, `auto-drafted` (an automatic draft) → swap it for `hors-saison`,
 *       so the stock-check cannot revive it before the season
 *     - seasonal, out of season, WITHOUT `auto-drafted` → never touched: an operator's draft (or
 *       one of unknown origin) is never marked, so it is never published at a season start
 *     - `auto-drafted`, not seasonal-out, sellable in today's feed → ACTIVE (+ publish)
 *   Any other draft (an operator's, an import awaiting review…) is never touched.
 *
 * Sellable = the same buffered rule as the rest of the app: Aosom `stockBufferQty(feedQty) > 0`
 * (qty > 10) from a FRESH CSV; Costway `in_stock = 1 AND sellableQty(qty) > 0` (qty ≥ 3) from
 * `costway_products` (refreshed by the daily costway-sync).
 *
 * Seasonal rule (Halloween): the Shopify `product_type` contains the word « Halloween »
 * (`Holiday & Seasonal > Halloween Decorations`, both the old `Home Furnishings > …` and the new
 * top-level forms). NOT the tags: a Christmas tree carries the tag `Halloween` on this store.
 * Season window, store-local (America/Toronto): from 09-01 (inclusive) to 11-01 (exclusive) by
 * default, overridable without a deploy in `settings.seasonal_windows`
 * (JSON `{"halloween":{"start":"09-01","end":"11-01"}}`).
 *
 * Mode: `settings.sold_out_hide_mode` = off | dry | live (default live). The cron passes
 * `?mode=dry` for a dry run. Writes are capped per run and spaced 2/s.
 */
import { applyStockTags, stockBufferQty, STOCK_TAG_AUTODRAFTED } from "./diff-engine";
import { EXCLUDE_TAG } from "./stale-catalog";
import { sellableQty } from "./costway/pricing";

export const SEASON_TAG = "hors-saison";
/** auto-import's hold-for-review tag (process-one.ts REVIEW_TAG — not imported, that module pulls Shopify I/O). */
export const NEEDS_REVIEW_TAG = "needs-review";
export const SOLD_OUT_HIDE_MODE_KEY = "sold_out_hide_mode";
export const SEASONAL_WINDOWS_KEY = "seasonal_windows";
/** Max Shopify writes per run. Convergent, so a capped run is drained by the next one. */
export const SOLD_OUT_HIDE_WRITE_CAP = 150;
/** Spacing between Shopify writes → 2 requests/second (same as stale-catalog / stock-check). */
export const RATE_LIMIT_MS = 500;
/**
 * Circuit breaker: refuse to draft more than max(MIN, FRACTION × active products) in ONE run.
 * A broken stock source (all zeros) must not empty the store. Measured on 2026-11-04: ~60
 * candidates out of ~3,480 active products.
 */
export const MASS_HIDE_MIN = 200;
export const MASS_HIDE_FRACTION = 0.1;

export type HideMode = "off" | "dry" | "live";

export interface SeasonWindow {
  /** "MM-DD", inclusive, store-local. */
  start: string;
  /** "MM-DD", exclusive, store-local. A window may wrap the year end (start > end). */
  end: string;
}

export interface SeasonalRule {
  key: string;
  /** true when the product belongs to this season. */
  matches: (p: { productType: string }) => boolean;
  window: SeasonWindow;
}

export const DEFAULT_SEASON_WINDOWS: Record<string, SeasonWindow> = {
  halloween: { start: "09-01", end: "11-01" },
};

/** product_type contains the WORD Halloween — the rule shown in the module header. */
export function isHalloweenProductType(productType: string): boolean {
  return /\bhalloween\b/i.test(productType || "");
}

/** Rules from the raw `settings.seasonal_windows` value — the job AND the feeds use this. */
export function seasonalRulesFromSetting(raw: string | null | undefined): SeasonalRule[] {
  return seasonalRules(parseSeasonWindows(raw));
}

export function seasonalRules(windows: Record<string, SeasonWindow> = DEFAULT_SEASON_WINDOWS): SeasonalRule[] {
  return [
    {
      key: "halloween",
      matches: (p) => isHalloweenProductType(p.productType),
      window: windows.halloween ?? DEFAULT_SEASON_WINDOWS.halloween,
    },
  ];
}

const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Parse `settings.seasonal_windows`; anything malformed falls back to the default window. */
export function parseSeasonWindows(raw: string | null | undefined): Record<string, SeasonWindow> {
  const out: Record<string, SeasonWindow> = { ...DEFAULT_SEASON_WINDOWS };
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<SeasonWindow>>;
    for (const [k, w] of Object.entries(parsed ?? {})) {
      if (w && typeof w.start === "string" && typeof w.end === "string" && MMDD.test(w.start) && MMDD.test(w.end)) {
        out[k] = { start: w.start, end: w.end };
      }
    }
  } catch {
    /* keep defaults */
  }
  return out;
}

/** Store-local "MM-DD" for an instant. */
export function storeMonthDay(now: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", month: "2-digit", day: "2-digit" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.month}-${parts.day}`;
}

export function isInSeason(window: SeasonWindow, now: Date): boolean {
  const md = storeMonthDay(now);
  if (window.start <= window.end) return md >= window.start && md < window.end;
  return md >= window.start || md < window.end; // wraps the year end
}

/** The out-of-season rule this product falls under right now, or null. */
export function outOfSeasonRule(productType: string, rules: SeasonalRule[], now: Date): SeasonalRule | null {
  for (const r of rules) if (r.matches({ productType }) && !isInSeason(r.window, now)) return r;
  return null;
}

// ── Sellability ──────────────────────────────────────────────────────────────

export interface Availability {
  /** at least one of the product's SKUs is in today's stock source. */
  present: boolean;
  /** at least one variant can be sold. */
  sellable: boolean;
}

/** Aosom: from today's CSV qty per SKU. An absent SKU is not sellable. */
export function aosomAvailability(skus: string[], csvQtyBySku: Map<string, number>): Availability {
  let present = false;
  let sellable = false;
  for (const s of skus) {
    const q = csvQtyBySku.get(s);
    if (q == null) continue;
    present = true;
    if (stockBufferQty(q) > 0) sellable = true;
  }
  return { present, sellable };
}

export interface CostwayStockRow {
  inStock: boolean;
  qty: number;
}

/** Costway: `in_stock` flag AND at least 3 units (sellableQty), per variant row. */
export function costwayAvailability(rows: CostwayStockRow[]): Availability {
  return {
    present: rows.length > 0,
    sellable: rows.some((r) => r.inStock && sellableQty(r.qty) > 0),
  };
}

// ── Planner ──────────────────────────────────────────────────────────────────

export interface HideCandidateProduct {
  shopifyProductId: string;
  title: string;
  handle: string;
  status: "active" | "draft" | "archived";
  tags: string[];
  productType: string;
  skus: string[];
  source: "aosom" | "costway";
  availability: Availability;
}

export type HideActionKind = "hide_sold_out" | "hide_season" | "mark_season" | "release_season" | "reactivate";

export interface PlannedHideAction {
  shopifyProductId: string;
  title: string;
  handle: string;
  skus: string[];
  source: "aosom" | "costway";
  action: HideActionKind;
  reason: string;
  currentStatus: "active" | "draft" | "archived";
  targetStatus: "active" | "draft";
  /** the full tag list to write (Shopify replaces the list). */
  tags: string[];
  /** the tag list before the change — with currentStatus, the rollback record. */
  previousTags: string[];
}

export interface HidePlanInput {
  products: HideCandidateProduct[];
  /** Shopify product ids in an open (unfulfilled / partially fulfilled) order — never touched. */
  openOrderProductIds: Set<string>;
  rules: SeasonalRule[];
  now: Date;
}

export interface HidePlan {
  actions: PlannedHideAction[];
  counts: {
    products: number;
    hideSoldOut: number;
    hideSeason: number;
    markSeason: number;
    releaseSeason: number;
    reactivate: number;
    skippedOpenOrder: number;
    skippedExcludeStale: number;
    /** active, sold out, but absent from the feed — left to removed-catalog / stale-catalog. */
    skippedAbsentFromFeed: number;
    activeProducts: number;
  };
}

const lc = (t: string) => t.toLowerCase();
const hasTag = (tags: string[], tag: string) => tags.some((t) => lc(t) === lc(tag));
const withTag = (tags: string[], tag: string) => (hasTag(tags, tag) ? tags : [...tags, tag]);
const withoutTag = (tags: string[], tag: string) => tags.filter((t) => lc(t) !== lc(tag));

export function planSoldOutHide(input: HidePlanInput): HidePlan {
  const actions: PlannedHideAction[] = [];
  const counts: HidePlan["counts"] = {
    products: input.products.length,
    hideSoldOut: 0, hideSeason: 0, markSeason: 0, releaseSeason: 0, reactivate: 0,
    skippedOpenOrder: 0, skippedExcludeStale: 0, skippedAbsentFromFeed: 0, activeProducts: 0,
  };

  const push = (p: HideCandidateProduct, a: Omit<PlannedHideAction, "shopifyProductId" | "title" | "handle" | "skus" | "source" | "currentStatus" | "previousTags">) =>
    actions.push({ shopifyProductId: p.shopifyProductId, title: p.title, handle: p.handle, skus: p.skus, source: p.source, currentStatus: p.status, previousTags: p.tags, ...a });

  for (const p of input.products) {
    if (p.status === "archived") continue;
    if (p.status === "active") counts.activeProducts++;
    const pinned = hasTag(p.tags, EXCLUDE_TAG);
    const offSeason = outOfSeasonRule(p.productType, input.rules, input.now);
    const { present, sellable } = p.availability;

    if (p.status === "active") {
      if (pinned) {
        if (offSeason || (present && !sellable)) counts.skippedExcludeStale++;
        continue;
      }
      if (offSeason || (present && !sellable)) {
        if (input.openOrderProductIds.has(p.shopifyProductId)) { counts.skippedOpenOrder++; continue; }
      }
      if (offSeason) {
        const tags = withTag(withoutTag(p.tags, STOCK_TAG_AUTODRAFTED), SEASON_TAG);
        push(p, { action: "hide_season", reason: `hors saison (${offSeason.key}, de retour le ${offSeason.window.start})`, targetStatus: "draft", tags });
        counts.hideSeason++;
      } else if (present && !sellable) {
        const tags = withTag(applyStockTags(p.tags, false), STOCK_TAG_AUTODRAFTED);
        push(p, { action: "hide_sold_out", reason: "rupture de stock (toutes les variantes)", targetStatus: "draft", tags });
        counts.hideSoldOut++;
      } else if (!present && !sellable) {
        counts.skippedAbsentFromFeed++;
      }
      continue;
    }

    // ── status = draft ──
    const seasonMarked = hasTag(p.tags, SEASON_TAG);
    const autoDrafted = hasTag(p.tags, STOCK_TAG_AUTODRAFTED);

    if (seasonMarked) {
      if (offSeason) continue; // still out of season — stays hidden
      if (pinned) continue;
      if (sellable) {
        const tags = withoutTag(withoutTag(applyStockTags(p.tags, true), SEASON_TAG), STOCK_TAG_AUTODRAFTED);
        push(p, { action: "reactivate", reason: "saison commencée, en stock", targetStatus: "active", tags });
        counts.reactivate++;
      } else {
        // Season started but nothing to sell: hand it over to the sold-out marker, so it comes
        // back on restock (this job or stock-check).
        const tags = withTag(withoutTag(p.tags, SEASON_TAG), STOCK_TAG_AUTODRAFTED);
        push(p, { action: "release_season", reason: "saison commencée, toujours en rupture", targetStatus: "draft", tags });
        counts.releaseSeason++;
      }
      continue;
    }

    if (offSeason) {
      // Only an AUTOMATIC draft (`auto-drafted`: this job or stock-check) is converted to
      // `hors-saison`, so the stock-check cannot revive it before the season. A draft without
      // that marker belongs to an operator (or has an unknown origin): it is NEVER marked,
      // because marking it would make this job publish it at the next season start. An import
      // held for review is never marked either.
      if (!autoDrafted || pinned || hasTag(p.tags, NEEDS_REVIEW_TAG)) continue;
      const tags = withTag(withoutTag(p.tags, STOCK_TAG_AUTODRAFTED), SEASON_TAG);
      push(p, { action: "mark_season", reason: `brouillon automatique, passé hors saison (${offSeason.key})`, targetStatus: "draft", tags });
      counts.markSeason++;
      continue;
    }

    if (autoDrafted && !pinned && present && sellable) {
      const tags = withoutTag(applyStockTags(p.tags, true), STOCK_TAG_AUTODRAFTED);
      push(p, { action: "reactivate", reason: "de retour en stock", targetStatus: "active", tags });
      counts.reactivate++;
    }
  }

  // Worst-first: availability lost before restored, so the write cap never starves a hide.
  const rank: Record<HideActionKind, number> = { hide_sold_out: 0, hide_season: 1, reactivate: 2, release_season: 3, mark_season: 4 };
  actions.sort((a, b) => rank[a.action] - rank[b.action] || a.shopifyProductId.localeCompare(b.shopifyProductId));
  return { actions, counts };
}

/** Throws when a run would draft an implausible share of the store (broken stock source). */
export function assertHidePlausible(plan: HidePlan): void {
  const hides = plan.counts.hideSoldOut + plan.counts.hideSeason;
  const limit = Math.max(MASS_HIDE_MIN, Math.floor(MASS_HIDE_FRACTION * plan.counts.activeProducts));
  if (hides > limit) {
    throw new Error(`sold-out-hide would draft ${hides} products (> ${limit}) — stock source looks broken, aborting before any write`);
  }
}

export function parseHideMode(raw: string | null | undefined): HideMode {
  return raw === "off" || raw === "dry" || raw === "live" ? raw : "live";
}
