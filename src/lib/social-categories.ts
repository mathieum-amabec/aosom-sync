/**
 * Category filter for the "Generate Highlights" button (dashboard /social).
 *
 * WHY product_type AND NOT SHOPIFY TAGS
 * The brief asked for Halloween/Noël to be selected by Shopify tag. There is no `tags`
 * column in Turso — tags live only on Shopify, so tag filtering would mean paging the whole
 * Admin API (7 pages, ~30 s) on every click. It turns out not to be needed: Aosom's own
 * `product_type` already carries the seasonal branch, verified against production on
 * 2026-09-03:
 *
 *     Home Furnishings > Holiday & Seasonal > Halloween Decorations          34
 *     Home Furnishings > Holiday & Seasonal > Christmas Trees > …            52
 *     Home Furnishings > Holiday & Seasonal > Christmas Decorations > …       3
 *
 * So every category here is one indexed-ish LIKE on a column we already hold. No API call,
 * no cache to invalidate, and it keeps working when a product's Shopify tags are edited.
 *
 * WHY has_discount AND NOT compare_at_price
 * The brief asked for `compare_at_price > price`. Turso has no compare_at column: the
 * repo's canonical discount signal is the precomputed `has_discount` flag (recomputed each
 * sync from price_history), which is also what the catalog's "Avec rabais" filter uses and
 * what `idx_products_has_discount` indexes. Shopify's compare_at is only ever SET for drops
 * ≥ MIN_DISCOUNT_DISPLAY_PERCENT (10%), so it is a strictly narrower, less current signal.
 *
 * Counts below are the eligible pool (imported + in stock) measured 2026-09-03.
 */

/** A category the operator can pick before generating. */
export interface SocialCategory {
  key: string;
  /** Shown in the dropdown, emoji included. */
  label: string;
  /** SQL fragment appended to the eligibility WHERE clause. `null` = no filter. */
  predicate: string | null;
  /** Positional args for `predicate`. */
  args: (string | number)[];
  /** Eligible SKUs when this was written (imported, in stock, outside the repost window). */
  measuredPool: number;
  /**
   * Of those, how many carry Shopify's `lifestyle-verified` tag — the ONLY ones the
   * generator will post, since a highlight never goes out on a white-background photo.
   * This, not measuredPool, decides whether a category can produce anything at all:
   * Halloween has 34 eligible products and 0 verified, so today it cannot post.
   * Measured 2026-09-03 against live Shopify tags. Operator messaging only, never
   * filtering — going stale degrades a hint, not the feature.
   */
  measuredLifestylePool: number;
}

/** `all` first; the rest in the order the dropdown shows them. */
export const SOCIAL_CATEGORIES: SocialCategory[] = [
  { key: "all", label: "Toutes les catégories", predicate: null, args: [], measuredPool: 2350, measuredLifestylePool: 658 },
  {
    key: "halloween",
    label: "🎃 Halloween",
    predicate: "product_type LIKE 'Home Furnishings > Holiday & Seasonal > Halloween%'",
    args: [],
    measuredPool: 34, measuredLifestylePool: 0,
  },
  {
    key: "noel",
    label: "🎄 Noël",
    predicate: "product_type LIKE 'Home Furnishings > Holiday & Seasonal > Christmas%'",
    args: [],
    measuredPool: 54, measuredLifestylePool: 7,
  },
  {
    key: "salon",
    label: "Salon & Canapés",
    predicate: "product_type LIKE 'Home Furnishings > Living Room Furniture%'",
    args: [],
    measuredPool: 291, measuredLifestylePool: 102,
  },
  {
    key: "chambre",
    label: "Chambre & Literie",
    predicate: "product_type LIKE 'Home Furnishings > Bedroom Furniture%'",
    args: [],
    measuredPool: 94, measuredLifestylePool: 30,
  },
  {
    key: "bureau",
    label: "Bureau & Télétravail",
    predicate: "product_type LIKE 'Office Products%'",
    args: [],
    measuredPool: 217, measuredLifestylePool: 59,
  },
  {
    key: "exterieur",
    label: "Extérieur & Patio",
    predicate: "product_type LIKE 'Patio & Garden%'",
    args: [],
    measuredPool: 525, measuredLifestylePool: 159,
  },
  {
    key: "cuisine",
    label: "Cuisine & Salle à manger",
    predicate: "product_type LIKE 'Home Furnishings > Kitchen & Dining Furniture%'",
    args: [],
    measuredPool: 253, measuredLifestylePool: 114,
  },
  {
    key: "rangement",
    label: "Rangement",
    predicate: "product_type LIKE 'Home Furnishings > Storage & Organization%'",
    args: [],
    measuredPool: 227, measuredLifestylePool: 10,
  },
  {
    key: "enfants",
    label: "Enfants & Jouets",
    predicate: "product_type LIKE 'Toys & Games%'",
    args: [],
    measuredPool: 184, measuredLifestylePool: 64,
  },
  {
    key: "animaux",
    label: "Animaux",
    predicate: "product_type LIKE 'Pet Supplies%'",
    args: [],
    measuredPool: 187, measuredLifestylePool: 100,
  },
  {
    key: "solde",
    label: "En solde",
    // See the header: has_discount is the repo's discount signal, not compare_at_price.
    predicate: "has_discount = 1",
    args: [],
    measuredPool: 1404, measuredLifestylePool: 392,
  },
  {
    key: "nouveautes",
    label: "Nouveautés (30 j)",
    predicate: "created_at > strftime('%s','now','-30 day')",
    args: [],
    // ⚠️ Only 5 eligible products on 2026-09-03. The highlight generator samples a dozen
    // candidates and posts the first lifestyle-verified one, so this category can legitimately
    // return nothing. The route surfaces that instead of failing silently.
    measuredPool: 5, measuredLifestylePool: 0,
  },
];

const BY_KEY = new Map(SOCIAL_CATEGORIES.map((c) => [c.key, c]));

/** Look up a category, or undefined when the key is unknown. */
export function getCategory(key: string | null | undefined): SocialCategory | undefined {
  if (!key) return undefined;
  return BY_KEY.get(key);
}

/** True for a key the dropdown could legitimately have sent. `all` counts as valid. */
export function isValidCategory(key: string | null | undefined): boolean {
  return !!key && BY_KEY.has(key);
}

/**
 * Below this many lifestyle-verified products, one sample sees the whole pool and a miss
 * is a real risk rather than bad luck — so the caller warns instead of pretending the empty
 * result is normal. Matches HIGHLIGHT_LIFESTYLE_SAMPLE in job4-social.ts, the number of
 * candidates the generator draws per draft.
 *
 * Measured odds that one draft finds a verified product, 2026-09-03: cuisine and animaux
 * 100%, most categories >99%, rangement 50% (10 verified of 227), halloween and nouveautes
 * 0%.
 */
export const THIN_POOL_THRESHOLD = 15;

// ─── Seasonal default ────────────────────────────────────────────────

/**
 * The category to PRIORITISE when the operator picks nothing, by calendar month.
 *
 *   Sept–Oct  → Halloween
 *   Nov–Dec   → Noël
 *   Jan–Feb   → interior comfort (mapped to Salon & Canapés, the largest indoor pool)
 *   Jun–Aug   → Extérieur & Patio
 *   Mar–May   → no preference; the full catalog is the sensible spring default
 *
 * PRIORITY, NOT A HARD FILTER. Halloween is 34 products and Noël 55; a strict seasonal
 * filter would routinely find no lifestyle-verified candidate and produce zero drafts in
 * exactly the months the operator most wants posts. `runStockHighlight` therefore tries
 * the seasonal category first and falls back to the whole catalog. An EXPLICIT choice is
 * never softened this way — if you pick Halloween, you get Halloween or a clear message.
 *
 * `month` is 1-12. Defaults to the current month in the server's timezone; pass it in tests.
 */
export function seasonalDefaultCategory(month: number = new Date().getMonth() + 1): string | null {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (month === 9 || month === 10) return "halloween";
  if (month === 11 || month === 12) return "noel";
  if (month === 1 || month === 2) return "salon";
  if (month >= 6 && month <= 8) return "exterieur";
  return null;
}

/**
 * Resolve what the generator should actually filter on.
 *
 * `explicit` wins and is strict. Absent (or "all"), the seasonal default applies as a soft
 * preference the caller may abandon. Returns the category plus whether a miss is allowed to
 * fall back.
 */
export function resolveCategory(
  explicit: string | null | undefined,
  month?: number,
): { category: SocialCategory | null; source: "explicit" | "seasonal" | "none"; canFallBack: boolean } {
  if (explicit && explicit !== "all") {
    const c = getCategory(explicit);
    if (c) return { category: c, source: "explicit", canFallBack: false };
    // Unknown key: treat as no filter rather than silently generating from a typo.
    return { category: null, source: "none", canFallBack: false };
  }
  if (explicit === "all") return { category: null, source: "none", canFallBack: false };

  const seasonal = getCategory(seasonalDefaultCategory(month) ?? undefined);
  if (seasonal) return { category: seasonal, source: "seasonal", canFallBack: true };
  return { category: null, source: "none", canFallBack: false };
}
