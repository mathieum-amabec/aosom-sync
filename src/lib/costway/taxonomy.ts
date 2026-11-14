/**
 * Costway → Ameublo taxonomy for the appliance pilot (Mat, 2026-10-03).
 *
 * Costway's own category is unreliable (a 2026-10-03 scan found 20 towel warmers filed as "Dryers" and
 * a humidifier filed as "Dehumidifiers"), so a product is classified from its TITLE as well as its
 * category, and anything ambiguous is left out rather than guessed.
 *
 * The product_type strings are chosen so the EXISTING smart collections pick the products up by
 * themselves (they are rules on `product_type contains …`, see docs/taxonomie-categories.md):
 *   "Home Furnishings > Appliances"  → Électro & Tech (parent)
 *   "Dehumidifier"                   → Climatisation & Ventilation (existing)
 * plus two new collections created by scripts/costway-setup-shopify.mts:
 *   "Dehumidifiers"                  → Déshumidificateurs
 *   "Washing Machines" / "Clothes Dryers" / "Washer Dryer" → Buanderie
 */
export type CostwayKind = "dehumidifier" | "washer" | "dryer" | "washer_dryer";

export const KIND_PRODUCT_TYPE: Record<CostwayKind, string> = {
  dehumidifier: "Home Furnishings > Appliances > Dehumidifiers",
  washer: "Home Furnishings > Appliances > Washing Machines",
  dryer: "Home Furnishings > Appliances > Clothes Dryers",
  washer_dryer: "Home Furnishings > Appliances > Washer Dryer Combos",
};

/** Neutral tag put on every Costway product — public, so it says nothing about the supplier. */
export const SOURCE_TAG = "src-c";

/** Mis-filed by Costway: warmers and humidifiers sit next to dryers / dehumidifiers. */
const NOT_THE_APPLIANCE = /towel warm|blanket warm|(?<![dD]e)humidifier|air purifier/i;
/** Multi-product kits and furniture bundles: harder to order by hand, kept out of the pilot. */
const KIT = /\bbundle\b|\bkit\b|cabinet|storage rack|wall[- ]mount(ed)? (shelf|unit)/i;
const TWIN_TUB = /twin[- ]?tub|semi[- ]?auto|spin[- ]?dry/i;

/** The appliance kind, or null when the product is not a clear member of one. */
export function classifyCostway(title: string, category: string): CostwayKind | null {
  const t = title ?? "";
  if (NOT_THE_APPLIANCE.test(t) || KIT.test(t)) return null;

  if (/dehumidifier/i.test(t) && /dehumidifier/i.test(category)) return "dehumidifier";

  const washer = /wash(ing)?[- ]?(machine|er)\b|laundry washer/i.test(t);
  const dryer = /\bdryer\b|tumble/i.test(t);
  if (washer && dryer && !TWIN_TUB.test(t) && /combo|washer (and|&) dryer|washer[- ]dryer|all[- ]in[- ]one|laundry center/i.test(t)) {
    return "washer_dryer";
  }
  if (washer) return "washer";
  if (dryer && /dryers?/i.test(category)) return "dryer";
  return null;
}
