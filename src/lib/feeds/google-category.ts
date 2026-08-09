// Map an Aosom product_type (already a "A > B > C" taxonomy path) to a Google Product
// Category. Google accepts either the numeric id or the full category path; we emit the id.
//
// EVERY id below was verified against the official taxonomy dump
// (https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt,
// Google_Product_Taxonomy_Version 2021-09-21) on 2026-08-09, and the `name` on each rule is
// the verbatim path that file gives for that id. Do not add an id without looking it up
// there first: an id that does not resolve is not a "coarse" category, it is a *different*
// category, and Google will match the product against it.
//
// That is not hypothetical. Four of the seven ids this file previously used pointed at
// unrelated categories:
//   220  claimed "Toys & Games"              -> actually Collectible Weapons
//   3553 claimed "Outdoor Grills"            -> actually Dinnerware > Plates
//   6792 claimed "Furniture > Outdoor Furn." -> actually Home & Garden > Fireplaces
//   2962 claimed "Lawn & Garden"             -> actually Lawn & Garden > Gardening (defensible)
// ~490 live items (22.5% of the feed) were categorised into those wrong buckets.
export interface GoogleCategory {
  id: number;
  /** Verbatim Google taxonomy path for `id` (documentation + test evidence; not emitted). */
  name: string;
}

// Order matters. The Aosom path always leads with a broad top-level ("Patio & Garden > …",
// "Home Furnishings > …"), so specific leaves must be tested before the broad fallbacks:
//   - pet / toys / grill / structures first (unambiguous leaves),
//   - within furniture, the specific piece (bar stool, coffee table) before the generic
//     "chair"/"table"/"cabinet" catch-alls,
//   - outdoor seating before indoor seating, since "Patio & Garden > … > Lounger Chairs"
//     contains "chair" and would otherwise be read as an indoor chair.
const RULES: Array<{ test: RegExp; cat: GoogleCategory }> = [
  // ── Animals & Pet Supplies ────────────────────────────────────────────────
  { test: /bird cage|bird stand|\bbirds?\b/i, cat: { id: 4989, name: "Animals & Pet Supplies > Pet Supplies > Bird Supplies > Bird Cages & Stands" } },
  { test: /cat (tree|tower|condo|furniture|enclosure|catio)|outdoor cat/i, cat: { id: 4997, name: "Animals & Pet Supplies > Pet Supplies > Cat Supplies > Cat Furniture" } },
  { test: /cat bed/i, cat: { id: 4433, name: "Animals & Pet Supplies > Pet Supplies > Cat Supplies > Cat Beds" } },
  { test: /dog house|kennel|dog run|playpen|dog crate/i, cat: { id: 7274, name: "Animals & Pet Supplies > Pet Supplies > Dog Supplies > Dog Kennels & Runs" } },
  { test: /dog bed|pet bed/i, cat: { id: 4434, name: "Animals & Pet Supplies > Pet Supplies > Dog Supplies > Dog Beds" } },
  { test: /rabbit|hutch|guinea|hamster|chicken|poultry|coop|small animal/i, cat: { id: 5017, name: "Animals & Pet Supplies > Pet Supplies > Small Animal Supplies > Small Animal Habitats & Cages" } },
  { test: /pet carrier|pet crate/i, cat: { id: 6251, name: "Animals & Pet Supplies > Pet Supplies > Pet Carriers & Crates" } },
  { test: /\bpet supplies\b|\bpets?\b|cats?\b|dogs?\b/i, cat: { id: 2, name: "Animals & Pet Supplies > Pet Supplies" } },

  // ── Toys & Games ──────────────────────────────────────────────────────────
  { test: /trampoline/i, cat: { id: 1738, name: "Toys & Games > Outdoor Play Equipment > Trampolines" } },
  { test: /toys|ride-?on|tricycle|go ?kart|electric (toy )?car|toddler|\bkids\b|playhouse|swing set|slide/i, cat: { id: 1253, name: "Toys & Games > Toys" } },

  // ── Outdoor cooking ───────────────────────────────────────────────────────
  { test: /bbq|barbecue|\bgrill/i, cat: { id: 2985, name: "Home & Garden > Kitchen & Dining > Kitchen Appliances > Outdoor Grills" } },

  // ── Outdoor structures (before outdoor furniture: a gazebo is not seating) ─
  { test: /gazebo|canopy|pergola|car ?port|party tent|sun ?shelter/i, cat: { id: 716, name: "Home & Garden > Lawn & Garden > Outdoor Living > Outdoor Structures > Canopies & Gazebos" } },
  // `sheds?` not `shed\b`: the live path is "… > Lawn & Garden > Sheds", and a \b-anchored
  // singular falls through to the broad Lawn & Garden rule below.
  { test: /\bsheds?\b|storage shed|bike shed|garages?\b/i, cat: { id: 720, name: "Home & Garden > Lawn & Garden > Outdoor Living > Outdoor Structures > Sheds, Garages & Carports" } },
  { test: /greenhouse|cold frame/i, cat: { id: 693, name: "Home & Garden > Lawn & Garden > Gardening > Greenhouses" } },
  { test: /umbrella|parasol|sunshade|shade sail/i, cat: { id: 719, name: "Home & Garden > Lawn & Garden > Outdoor Living > Outdoor Umbrellas & Sunshades" } },

  // ── Outdoor furniture ─────────────────────────────────────────────────────
  { test: /sun ?lounger|lounger|chaise|deck chair/i, cat: { id: 4105, name: "Furniture > Outdoor Furniture > Outdoor Seating > Sunloungers" } },
  { test: /outdoor (sofa|sectional)|patio sofa|conversation set/i, cat: { id: 4513, name: "Furniture > Outdoor Furniture > Outdoor Seating > Outdoor Sofas" } },
  { test: /outdoor bench|garden bench|patio bench/i, cat: { id: 5044, name: "Furniture > Outdoor Furniture > Outdoor Seating > Outdoor Benches" } },
  { test: /outdoor (chair|seat)|patio chair|adirondack|egg chair|hanging chair/i, cat: { id: 6828, name: "Furniture > Outdoor Furniture > Outdoor Seating > Outdoor Chairs" } },
  { test: /outdoor table|patio table|bistro (set|table)/i, cat: { id: 2684, name: "Furniture > Outdoor Furniture > Outdoor Tables" } },
  { test: /deck box|outdoor storage/i, cat: { id: 7310, name: "Furniture > Outdoor Furniture > Outdoor Storage Boxes" } },
  { test: /patio (furniture|set)|outdoor furniture/i, cat: { id: 6367, name: "Furniture > Outdoor Furniture > Outdoor Furniture Sets" } },

  // ── Gardening ─────────────────────────────────────────────────────────────
  { test: /raised (garden )?bed|planter|garden pot|grow bag/i, cat: { id: 721, name: "Home & Garden > Lawn & Garden > Gardening > Pots & Planters" } },
  { test: /lawn & garden|garden (structure|pathway|decor)|trellis|compost/i, cat: { id: 689, name: "Home & Garden > Lawn & Garden" } },

  // ── Office furniture (before generic chair/table/cabinet) ─────────────────
  { test: /massage chair/i, cat: { id: 2919, name: "Furniture > Chairs > Electric Massaging Chairs" } },
  { test: /office chair|task chair|desk chair|gaming chair|executive chair/i, cat: { id: 2045, name: "Furniture > Office Furniture > Office Chairs" } },
  { test: /\bdesks?\b|computer desk|writing desk|standing desk/i, cat: { id: 4191, name: "Furniture > Office Furniture > Desks" } },
  { test: /file cabinet|filing cabinet/i, cat: { id: 463, name: "Furniture > Cabinets & Storage > File Cabinets" } },

  // ── Indoor seating ────────────────────────────────────────────────────────
  { test: /bar stool|counter stool|\bstools?\b/i, cat: { id: 1463, name: "Furniture > Chairs > Table & Bar Stools" } },
  { test: /dining chair|kitchen chair/i, cat: { id: 5886, name: "Furniture > Chairs > Kitchen & Dining Room Chairs" } },
  { test: /recliner|accent chair|arm ?chair|sleeper chair|releveur|riser chair/i, cat: { id: 6499, name: "Furniture > Chairs > Arm Chairs, Recliners & Sleeper Chairs" } },
  { test: /\bsofas?\b|loveseat|couch|sectional|futon/i, cat: { id: 460, name: "Furniture > Sofas" } },
  { test: /\bbench(es)?\b/i, cat: { id: 441, name: "Furniture > Benches" } },

  // ── Storage (BEFORE tables) ───────────────────────────────────────────────
  // "Kitchen & Dining Furniture > Bar Cabinets" contains "Dining", so the loose \bdining\b
  // table rule below would claim it. A cabinet is storage, not a table — match it first.
  { test: /bathroom vanity|vanity unit|meuble.?lavabo/i, cat: { id: 2081, name: "Furniture > Cabinets & Storage > Vanities > Bathroom Vanities" } },
  { test: /sideboard|buffet|credenza/i, cat: { id: 447, name: "Furniture > Cabinets & Storage > Buffets & Sideboards" } },
  { test: /bookcase|book ?shelf|shelving|standing shelf|étagère|etagere/i, cat: { id: 465, name: "Furniture > Shelving > Bookcases & Standing Shelves" } },
  { test: /room divider|\bpartition\b|privacy screen/i, cat: { id: 4163, name: "Furniture > Room Dividers" } },
  { test: /dresser|chest of drawers|commode/i, cat: { id: 4195, name: "Furniture > Cabinets & Storage > Dressers" } },
  { test: /wardrobe|armoire/i, cat: { id: 4063, name: "Furniture > Cabinets & Storage > Armoires & Wardrobes" } },
  { test: /cabinets?\b|cupboard|storage unit|pantry/i, cat: { id: 6356, name: "Furniture > Cabinets & Storage" } },

  // ── Tables ────────────────────────────────────────────────────────────────
  { test: /coffee table/i, cat: { id: 1395, name: "Furniture > Tables > Accent Tables > Coffee Tables" } },
  { test: /end table|side table|bedside|nightstand|night stand/i, cat: { id: 1549, name: "Furniture > Tables > Accent Tables > End Tables" } },
  { test: /console table|sofa table/i, cat: { id: 1602, name: "Furniture > Tables > Accent Tables > Sofa Tables" } },
  { test: /dining table|kitchen table|\bdining\b/i, cat: { id: 4355, name: "Furniture > Tables > Kitchen & Dining Room Tables" } },

  // ── Bedroom ───────────────────────────────────────────────────────────────
  { test: /headboard|footboard/i, cat: { id: 451, name: "Furniture > Beds & Accessories > Headboards & Footboards" } },
  { test: /mattress/i, cat: { id: 2696, name: "Furniture > Beds & Accessories > Mattresses" } },
  { test: /\bbed frames?\b|\bbeds?\b|bunk|daybed/i, cat: { id: 505764, name: "Furniture > Beds & Accessories > Beds & Bed Frames" } },

  // ── Decor & fitness ───────────────────────────────────────────────────────
  { test: /artificial (tree|plant|flora|flower)/i, cat: { id: 6265, name: "Home & Garden > Decor > Artificial Flora" } },
  { test: /home ?d[ée]cor|\bdecor\b|mirror|wall art/i, cat: { id: 696, name: "Home & Garden > Decor" } },
  { test: /exercise|fitness|treadmill|dumbbell|weight bench|home gym|rowing/i, cat: { id: 990, name: "Sporting Goods > Exercise & Fitness" } },

  // ── Broad furniture catch-alls (last) ─────────────────────────────────────
  { test: /office (products|furniture)/i, cat: { id: 6362, name: "Furniture > Office Furniture" } },
  { test: /\btables?\b/i, cat: { id: 6392, name: "Furniture > Tables" } },
  { test: /\bchairs?\b|seating/i, cat: { id: 443, name: "Furniture > Chairs" } },
  { test: /furniture|furnishings/i, cat: { id: 436, name: "Furniture" } },
];

/** Default when nothing matches: the catalog is furniture-dominant. */
export const DEFAULT_GOOGLE_CATEGORY: GoogleCategory = { id: 436, name: "Furniture" };

/** Every category this module can emit — used by tests to assert id/path integrity. */
export const ALL_GOOGLE_CATEGORIES: GoogleCategory[] = [
  ...RULES.map((r) => r.cat),
  DEFAULT_GOOGLE_CATEGORY,
];

export function mapToGoogleCategory(productType: string | null | undefined): GoogleCategory {
  const s = (productType ?? "").toString();
  for (const rule of RULES) {
    if (rule.test.test(s)) return rule.cat;
  }
  return DEFAULT_GOOGLE_CATEGORY;
}
