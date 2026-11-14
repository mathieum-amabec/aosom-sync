/**
 * Costway variant sizes. The feed describes a variant only by its colour; when one item is sold in several sizes of
 * the same colour (trees 6/7.5/9 ft, fireplaces 36/42/50 in, beds Twin/Full/Queen, Set of 1/2) the size lives in the
 * supplier TITLE, after the last "-" ("…Christmas Tree-7.5 ft") or at its start ("8 FT Pre-Lit…"). Without it the
 * import showed "Vert, Vert 2, Vert 3" (2026-10-17: 47 live products), so a shopper could not tell what they bought.
 *
 * Output is the ENGLISH size wording ("6 ft (183 cm)", "Set of 2", "Queen"): createShopifyProduct turns it into the
 * French label with toFrenchSize ("6 pi (183 cm)", "Lot de 2") and registers this wording as the EN translation.
 * Deterministic, no AI.
 */

export interface SizedVariant {
  title: string;
  sku: string;
  color: string;
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;
// A lone measurement, not one item of a "6/7.5/9 Feet" list (that list names every size of the family).
const LONE = (unit: string) => new RegExp(String.raw`(?<![\d./])${NUM}\s*(?:${unit})(?![\w/])`, "i");
const INCHES = LONE(String.raw`inches|inch|in\b|"`);
const FEET = LONE(String.raw`feet|foot|ft|'`);
const PINTS = LONE(String.raw`pints|pint`);
const WATTS = LONE("w");
const SET = /\bset of (\d+)\b(?!\/)/i;
// Not a bunk bed's configuration ("Twin Over Full"): that names the product, not a size to pick.
const BED = /(?<![\w/]|over )(twin|full|queen|king)(?![\w/]| over)/i;
const LETTER = /^(XS|S|M|L|XL|XXL)$/i;
const LETTER_EN: Record<string, string> = { XS: "X-Small", S: "Small", M: "Medium", L: "Large", XL: "X-Large", XXL: "XX-Large" };
const LETTER_RANK = ["XS", "S", "M", "L", "XL", "XXL"];

const trimNum = (n: number) => String(Math.round(n * 10) / 10);
const feet = (n: number) => `${trimNum(n)} ft (${Math.round(n * 30.48)} cm)`;
const inches = (n: number) => `${trimNum(n)} inches (${Math.round(n * 2.54)} cm)`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** The measurement-type sizes (a unit the shopper reads directly), tried on one piece of text. */
function measure(text: string): string {
  const set = text.match(SET);
  if (set) return set[1] === "1" ? "1 piece" : `Set of ${set[1]}`;
  const pints = text.match(PINTS);
  if (pints) return `${trimNum(Number(pints[1]))} pints`;
  const inch = text.match(INCHES);
  if (inch) return inches(Number(inch[1]));
  const ft = text.match(FEET);
  if (ft) return feet(Number(ft[1]));
  const bed = text.match(BED);
  if (bed) return cap(bed[1]);
  return "";
}

/** The size of ONE variant from its supplier title, "" when the title names none. */
export function sizeFromTitle(title: string): string {
  const cut = title.lastIndexOf("-");
  const suffix = cut > 0 ? title.slice(cut + 1).trim() : "";
  if (suffix && suffix.length <= 25) {
    const s = measure(suffix);
    if (s) return s;
    const w = suffix.match(WATTS);
    if (w) return `${w[1]}W`;
    const l = suffix.match(LETTER);
    if (l) return LETTER_EN[l[1].toUpperCase()];
  }
  return measure(cut > 0 ? title.slice(0, cut) : title);
}

const BED_SKU: Record<string, string> = { T: "Twin", F: "Full", Q: "Queen", K: "King" };

/**
 * One size per variant, or all "" when the colours already tell the variants apart. Returns null when two variants
 * still cannot be told apart: the item must not be imported as is (it would show "Vert", "Vert 2").
 */
export function variantSizes(vs: SizedVariant[]): string[] | null {
  const colours = new Set(vs.map((v) => v.color.trim().toLowerCase()));
  if (colours.size === vs.length) return vs.map(() => "");
  let sizes = vs.map((v) => sizeFromTitle(v.title));

  // Beds: Costway sometimes drops the size from one title but keeps it in the SKU ("…GR-F").
  if (sizes.some((s) => BED_SKU[s.charAt(0)] === s)) {
    sizes = sizes.map((s, i) => s || BED_SKU[vs[i].sku.match(/-([TFQK])$/i)?.[1].toUpperCase() ?? ""] || "");
  }

  // S/M/L on a family whose title lists every size ("6/7/8 FT …-M"): name the real size.
  const letters = sizes.map((s) => Object.keys(LETTER_EN).find((k) => LETTER_EN[k] === s));
  if (letters.every(Boolean)) {
    const list = vs[0].title.match(new RegExp(String.raw`${NUM}((?:/${NUM.slice(1, -1)})+)\s*(feet|foot|ft|inches|inch|")`, "i"));
    const values = list ? [list[1], ...list[2].split("/").filter(Boolean)].map(Number) : [];
    if (values.length === vs.length) {
      const rankOrder = [...new Set(letters as string[])].sort((a, b) => LETTER_RANK.indexOf(a) - LETTER_RANK.indexOf(b));
      const unitIsFeet = /feet|foot|ft/i.test(list![3]);
      if (rankOrder.length === values.length) {
        sizes = letters.map((l) => {
          const n = values[rankOrder.indexOf(l!)];
          return unitIsFeet ? feet(n) : inches(n);
        });
      }
    }
  }

  // Same colour AND same size (or no size) → still ambiguous.
  const keys = vs.map((v, i) => `${v.color.trim().toLowerCase()}|${sizes[i]}`);
  if (sizes.some((s, i) => !s && keys.filter((k) => k === keys[i]).length > 1)) return null;
  if (new Set(keys).size !== keys.length) return null;
  return sizes;
}

/** Numeric order for sizes ("6 ft…" < "7.5 ft…", Twin < Full < Queen, 1 piece < Set of 2), for the variant list. */
export function sizeRank(size: string): number {
  const bed = ["Twin", "Full", "Queen", "King"].indexOf(size);
  if (bed >= 0) return bed;
  const letter = Object.values(LETTER_EN).indexOf(size);
  if (letter >= 0) return letter;
  const n = size.match(/\d+(?:\.\d+)?/);
  return n ? Number(n[0]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Remove a single size from a generated title when the product is sold in several ("Arbre de Noël mince 152 cm" →
 * "Arbre de Noël mince"): the title must fit every variant. Also drops a "Lot de N" the supplier title never claimed
 * (the model wrote "Lot de 2" on a bunk bed sold in 2 colours).
 */
export function stripVariantSize(title: string, opts: { sizes: string[]; supplierTexts: string[] }): string {
  let t = title;
  const sized = opts.sizes.some(Boolean);
  if (sized) {
    t = t.replace(/\s*(?:de\s+|of\s+)?\d+(?:[.,]\d+)?\s*(?:cm|m²|po|pi|pintes|pints|in|inch|inches|ft|feet|")(?![\w²])/gi, "");
    if (opts.sizes.some((s) => /^(Twin|Full|Queen|King)$/.test(s))) t = t.replace(/\s+\b(queen|king|double|simple|twin|full)\b(?=\s)/gi, "");
  }
  const supplierSets = opts.supplierTexts.some((s) => /\bset of [2-9]|\b\d+\s*(?:pcs|pieces|pack)\b/i.test(s));
  if (sized || !supplierSets) t = t.replace(/\s*[—–-]\s*(?:lot|set|ensemble) (?:de|of) \d+\b/gi, "");
  return t.replace(/\s{2,}/g, " ").replace(/\s+([,—–-])\s*$/, "").trim();
}
