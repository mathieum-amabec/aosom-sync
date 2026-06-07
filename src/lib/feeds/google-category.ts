// Map an Aosom product_type (already a "A > B > C" taxonomy path) to a Google Product
// Category. Google accepts either the numeric id or the full category path; we emit the id.
//
// IDs are from the Google Product Taxonomy. They are coarse on purpose (the catalog is
// furniture/outdoor/pet/toy heavy) and should be re-verified periodically against
// https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt
export interface GoogleCategory {
  id: number;
  /** Human-readable Google taxonomy path (for docs/debugging; not emitted). */
  name: string;
}

// Order matters — disambiguating rules first. The Aosom path always starts with a broad
// top-level (e.g. "Patio & Garden > …"), so:
//  - pet/toys/bbq run first (they're unambiguous leaves),
//  - lawn-&-garden runs BEFORE patio (so a planter under "Patio & Garden > Lawn & Garden"
//    isn't misread as outdoor furniture just because the path contains "patio"),
//  - the patio rule uses furniture-specific keywords, not the bare "Patio & Garden".
const RULES: Array<{ test: RegExp; cat: GoogleCategory }> = [
  { test: /\bpet|cats?\b|dogs?\b|poultry|chicken|\banimal/i, cat: { id: 1, name: "Animals & Pet Supplies" } },
  { test: /toys|ride-?on|tricycle|go ?kart|motorcycle|toddler|\bkids\b/i, cat: { id: 220, name: "Toys & Games" } },
  { test: /bbq|grill/i, cat: { id: 3553, name: "Home & Garden > Lawn & Garden > Outdoor Living > Outdoor Grills" } },
  { test: /lawn & garden|raised garden|garden bed|garden structure|garden pathway|planter|greenhouse|garden decor|pergola|trellis|fountain/i, cat: { id: 2962, name: "Home & Garden > Lawn & Garden" } },
  { test: /patio furniture|patio chair|patio shade|sun lounger|lounger|umbrella|gazebo|glider|outdoor/i, cat: { id: 6792, name: "Furniture > Outdoor Furniture" } },
  { test: /office/i, cat: { id: 436, name: "Furniture" } },
  { test: /sofa|chair|table|\bbed\b|bedroom|dresser|cabinet|furniture|stool|divider|vanity|nightstand|bedside|console|shelf|wardrobe/i, cat: { id: 436, name: "Furniture" } },
];

/** Default when nothing matches: the catalog is furniture-dominant. */
export const DEFAULT_GOOGLE_CATEGORY: GoogleCategory = { id: 436, name: "Furniture" };

export function mapToGoogleCategory(productType: string | null | undefined): GoogleCategory {
  const s = (productType ?? "").toString();
  for (const rule of RULES) {
    if (rule.test.test(s)) return rule.cat;
  }
  return DEFAULT_GOOGLE_CATEGORY;
}
