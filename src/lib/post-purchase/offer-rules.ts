/**
 * Offre de remerciement — pure rules (Mat, 2026-11-21: "façon 1", thank-you page).
 *
 * After a purchase the thank-you page shows ONE related product (+ one alternative of another type) with a small
 * discount valid 30 minutes. Everything here is pure so it can be unit-tested and dry-run against real orders:
 *
 *   - which product is the "anchor" (the most expensive line of the order),
 *   - which catalogue rows go with it (hand-written category map — orders are too few to mine co-purchases),
 *   - seasonality, price cap, same-type exclusion, appliances never,
 *   - ranking (map order, colour family, price near 30 % of the anchor),
 *   - the discount tier each candidate can afford (10 % / 5 % / none) at today's cost.
 *
 * Data findings behind the map: scratchpad reco-findings.md (2026-11-21) — 81 % of last month's orders get ≥ 2
 * good candidates with the max(50 %, 50 $) cap.
 */
import { netProfit } from "@/lib/sell-price-rule";

/** One eligible catalogue variant (built nightly by the merci-catalog cron). */
export interface MerciCandidate {
  /** Numeric Shopify variant id. */
  variantId: string;
  /** Numeric Shopify product id. */
  productId: string;
  /** Supplier SKU (Shopify variant SKU) and supplier, so the offer can re-check today's cost and stock live. */
  sku: string;
  source: "aosom" | "costway";
  handle: string;
  /** French storefront title, with the variant's option values when it has any ("Table d'appoint — Noir"). */
  title: string;
  /** Normalised product type (see normalizeType). */
  type: string;
  /** Supplier colour, raw (family computed with colourFamily). */
  colour: string | null;
  price: number;
  compareAt: number | null;
  cost: number;
  imageUrl: string;
  /** Discount this variant can afford, from discountTier(). Never 0 in the catalogue. */
  pct: number;
}

/** One line of the order the customer just placed. */
export interface OrderLineInput {
  productId: string | null;
  productType: string;
  title: string;
  variantTitle?: string | null;
  /** Unit price before discounts. */
  price: number;
}

export interface MerciPick extends MerciCandidate {
  /** Short French reason shown under the title. */
  why: string;
  /** Price after the offer's discount. */
  discountedPrice: number;
  /**
   * Other variants of the same product that passed every filter, best first (max SIBLINGS_KEPT). The live re-check
   * falls back to them when the chosen variant fails (sold out, price moved, unpublished option).
   */
  siblings?: MerciCandidate[];
}

/** Sibling variants kept per product for the live re-check fallback. */
export const SIBLINGS_KEPT = 2;

/** Minimum profit after the offer discount and the card fees: max(8 $, 8 % of the discounted price). */
export const MIN_PROFIT_ABS = 8;
export const MIN_PROFIT_PCT = 0.08;
/** Offer tiers, best first. */
export const TIERS = [10, 5] as const;
/** Candidates priced under this are skipped (the catalogue has almost nothing useful below). */
export const MIN_CANDIDATE_PRICE = 15;
/** The cap is max(ANCHOR_SHARE × anchor, CAP_FLOOR), and never above the anchor itself. */
export const ANCHOR_SHARE = 0.5;
export const CAP_FLOOR = 50;
/** Sweet spot of an add-on, as a share of the anchor price. */
export const SWEET_SPOT = 0.3;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** NBSP and repeated spaces broke exact type matches (297 Shopify products carry U+00A0) — normalise both sides. */
export function normalizeType(t: string | null | undefined): string {
  return String(t ?? "")
    .replace(/[   ]/g, " ")
    .split(">")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" > ");
}

/** The deepest segment of a type, e.g. "Side Tables". */
export function leafOf(type: string): string {
  const segs = normalizeType(type).split(" > ");
  return segs[segs.length - 1] ?? "";
}

const NOUN_STOP = new Set(["with", "and", "accessories", "supplies", "furniture", "outdoor", "indoor"]);

/** Crude English singular: tables → table, benches → bench, shelves stay, trees → tree. */
function singular(w: string): string {
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** The head noun of a leaf ("Side Tables" → "table"), used to keep a second table/tree/sofa out. */
export function leafHead(type: string): string | null {
  const words = leafOf(type)
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4 && !NOUN_STOP.has(w))
    .map(singular);
  return words.length ? words[words.length - 1] : null;
}

// ─── Category map ───────────────────────────────────────────────────────────

const L = "Home Furnishings > Living Room Furniture";
const K = "Home Furnishings > Kitchen & Dining Furniture";
const B = "Home Furnishings > Bedroom Furniture";
const S = "Home Furnishings > Storage & Organization";
const O = "Office Products > Office Furniture";
const BA = "Home Furnishings > Bathroom Furniture";
const XM = "Christmas Decorations";
const FP = "Home Furnishings > Home Décor > Fireplaces & Accessories";

/**
 * Target syntax: "=X" exact type; "~regex" matched on the title; anything else = substring of the type.
 * Order = priority. Each rule also carries the French noun used in the "why" copy.
 */
export interface MapRule {
  anchor: RegExp;
  targets: string[];
  noun: string;
}

export const COMPLEMENT_MAP: MapRule[] = [
  { anchor: /Sofas & Reclining Chairs|Accent Chairs|Loveseats|Sofas/, noun: "nouveau salon", targets: [L + " > Side Tables", "=" + L, L + " > Coffee Tables", "Floor Lamps", "Area Rugs", S + " > Storage Ottomans & Benches"] },
  { anchor: /Coffee Tables/, noun: "nouvelle table basse", targets: [L + " > Side Tables", "=" + L, "Floor Lamps", "Area Rugs", L + " > Console Tables"] },
  { anchor: /Side Tables|Living Room Furniture$/, noun: "nouveau salon", targets: [L + " > Coffee Tables", "Floor Lamps", "Area Rugs", "=" + L] },
  { anchor: /TV Stands/, noun: "nouveau meuble télé", targets: [L + " > Side Tables", "Bookshelves", "Floor Lamps", "=" + L, L + " > Coffee Tables", "Artificial Trees"] },
  { anchor: /Console Tables|Room Dividers|Piano Benches/, noun: "nouvel aménagement", targets: ["Wall Mirrors", "Artificial Trees", L + " > Side Tables", "Floor Lamps"] },
  { anchor: /Dining Chairs|Dining Tables|Dining Table Sets|Kitchen & Dining Furniture$/, noun: "salle à manger", targets: [K + " > Kitchen Trash Cans", K + " > Kitchen Islands", K + " > Bar Cabinets", K + " > Household Supplies", "Wall Mirrors"] },
  { anchor: /Bar Stools|Bar Tables|Bar Sets/, noun: "coin repas", targets: [K + " > Kitchen Trash Cans", K + " > Kitchen Islands", K + " > Bar Tables", K + " > Household Supplies"] },
  { anchor: /Bar Cabinets|Kitchen Pantry|Kitchen Islands|Buffets/, noun: "cuisine", targets: [K + " > Kitchen Trash Cans", K + " > Bar Stools", K + " > Kitchen Islands", K + " > Household Supplies", "Wall Mirrors"] },
  { anchor: /Kitchen Trash Cans/, noun: "cuisine", targets: [K + " > Kitchen Islands", K + " > Household Supplies", K + " > Bar Stools"] },
  { anchor: /Bed Frames|Beds$/, noun: "nouvelle chambre", targets: [B + " > Bedside Tables", "Wall Mirrors", "Full Length Mirrors", S + " > Storage Ottomans & Benches", "Jewellery"] },
  { anchor: /Bedside Tables|Dressing|Mirrors|Jewellery|Dressers/, noun: "chambre", targets: ["Wall Mirrors", "Full Length Mirrors", "Jewellery", "Floor Lamps", "Salon Stools", B + " > Bedside Tables"] },
  { anchor: /Clothing Storage|Wardrobes/, noun: "rangement", targets: ["Full Length Mirrors", "Wall Mirrors", S + " > Shoe Storage", S + " > Storage Ottomans & Benches"] },
  { anchor: /Shoe Storage|Storage Ottomans|Storage Cabinets|Storage & Organization$/, noun: "entrée", targets: ["Wall Mirrors", S + " > Storage Ottomans & Benches", S + " > Shoe Storage", L + " > Console Tables", "Artificial Trees"] },
  { anchor: /Bookshelves/, noun: "nouvelle bibliothèque", targets: [L + " > Side Tables", "Floor Lamps", "Artificial Trees", O + " > Office Cabinets"] },
  { anchor: /Office Chairs/, noun: "bureau", targets: [O + " > Office Cabinets", "Bookshelves", O + " > Office Desks"] },
  { anchor: /Office Desks/, noun: "bureau", targets: [O + " > Office Chairs", O + " > Office Cabinets", "Bookshelves"] },
  { anchor: /Office Cabinets/, noun: "bureau", targets: [O + " > Office Chairs", "Bookshelves"] },
  { anchor: /Bathroom Cabinets|Medicine Cabinets/, noun: "salle de bain", targets: [BA + " > Bath Accessories", "Mirror Medicine Cabinets", "Wall Mounted Cabinets", "Over The Toilet", BA + " > Bath Chairs"] },
  { anchor: /Bath Accessories|Bath Chairs|Health Care/, noun: "salle de bain", targets: [BA + " > Bath Accessories", BA + " > Bath Chairs", "Health & Beauty > Health Care", "Wall Mounted Cabinets"] },
  { anchor: /Christmas Trees/, noun: "sapin", targets: [XM, "~jupe de sapin|tree skirt|guirlande", "Christmas Deer Lights"] },
  { anchor: /Christmas Decorations/, noun: "décor des Fêtes", targets: ["Christmas Trees", XM] },
  { anchor: /Fire Pits|Fireplaces|Firewood|Heater/, noun: "foyer", targets: ["Firewood Racks", FP, "Patio Furniture Covers", "Snow Shovels"] },
  { anchor: /Cat Litter/, noun: "chat", targets: ["Cats > Cat Trees", "Cats > Cat Houses"] },
  { anchor: /Cat Trees|Cat Houses|Cat Posts/, noun: "chat", targets: ["Cat Litter Box", "Cats > Cat Houses", "Cats > Cat Trees"] },
  { anchor: /Dog Stairs|Dog Sofas|Elevated Dog Beds/, noun: "chien", targets: ["Elevated Dog Beds", "Dog Sofas", "Pet Gates", "Dog Stairs"] },
  { anchor: /Pet Gates|Dog PlayPens|Dog Cages|Dog Kennels|Dog Bike/, noun: "chien", targets: ["Elevated Dog Beds", "Dog Stairs", "Pet Gates", "Dog Bowls"] },
  { anchor: /Small Kitchen Appliances/, noun: "cuisine", targets: [K + " > Kitchen Trash Cans", K + " > Kitchen Islands", K + " > Household Supplies"] },
  { anchor: /Washing|Dryer/, noun: "buanderie", targets: [BA + " > Bath Accessories", "Tilt Out Laundry", "Household Supplies"] },
  { anchor: /Sheds|Lawn & Garden|Patio|BBQ|Snow/, noun: "cour", targets: ["Snow Shovels", "Patio Furniture Covers", "Deck Box", "Home Improvement > Tools > Tool Organizers"] },
  { anchor: /Kids/, noun: "chambre d'enfant", targets: ["Baby & Kids Storage", "Kids Bedroom Furniture", "Kids Table Sets", "Kids Desk Sets"] },
  { anchor: /Strength Training|Weight Benches|Exercise/, noun: "coin d'entraînement", targets: ["Gymnastics Mats", "Strength Training Equipment", "Aerobic Equipment"] },
];

export function ruleFor(anchorType: string): MapRule | null {
  const t = normalizeType(anchorType);
  if (!t) return null;
  return COMPLEMENT_MAP.find((r) => r.anchor.test(t)) ?? null;
}

export function matchesTarget(type: string, title: string, target: string): boolean {
  if (target.startsWith("=")) return type === target.slice(1);
  if (target.startsWith("~")) return new RegExp(target.slice(1), "i").test(title);
  return type.includes(target);
}

// ─── Filters ────────────────────────────────────────────────────────────────

const SUMMER = /Sun Loungers|Patio Umbrellas|Umbrella Bases|Raised Garden|Gazebo|Pergola|Swimming|Pool|Hammock|Outdoor Gliders|Rocking Chairs|Patio Furniture Sets|Patio Chair Cushions|Bistro|Fans|Air Conditioner|Lawn Games|Water Fountains|Solar/;

/** Month 1–12 and day of month in Montréal time. */
export function montrealDate(now: Date): { month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", month: "numeric", day: "numeric" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { month: get("month"), day: get("day") };
}

export function montrealMonth(now: Date): number {
  return montrealDate(now).month;
}

/** Last December day a Christmas item is offered: a later order would not arrive before Christmas. */
export const CHRISTMAS_LAST_DAY = 15;

/**
 * Halloween only Sept–Oct; Christmas Nov 1 – Dec 15; summer patio blocked Oct–Mar (covers, deck boxes, shovels stay).
 * `day` defaults to 1 for callers that only know the month.
 */
export function outOfSeason(type: string, month: number, day = 1): boolean {
  if (/Halloween/i.test(type)) return month !== 9 && month !== 10;
  if (/Christmas/i.test(type)) return !(month === 11 || (month === 12 && day <= CHRISTMAS_LAST_DAY));
  if ((month >= 10 || month <= 3) && SUMMER.test(type)) return true;
  return false;
}

/**
 * Never offered as an add-on: appliances (no 2-year guarantee story, returns are costly), and anything electric that
 * heats — electric fireplaces, heaters, radiators — which the fireplace rule's targets would otherwise reach.
 */
const FIRE_AREA = /Fireplace|Fire Pits?|Firewood|Heat/i;
/** Fireplace-area items that are accessories, not units: logs, wood racks, tools, screens, grates. */
const FIRE_ACCESSORY = /b[ûu]ches?|outils|accessoires|r[âa]telier|porte-b[ûu]ches|support [àa] bois|range-bois|bois de chauffage|pare-[ée]tincelles|grille|log rack|firewood|\btools?\b|screen/i;
/** Fireplace-area items that are units (electric, gas or wood): never an add-on. */
const FIRE_UNIT = /foyer|po[êe]le|chemin[ée]e|insert|fireplace|stove/i;
/** Signs of a powered unit: electric (accented or not), smart/Wi-Fi, LED flames, wattage. */
const POWERED = /[ée]lectri|wi-?fi|intelligent|\bDEL\b|\bLED\b|quartz|infrarouge|\d+\s?W\b/i;

/**
 * Never offered as an add-on: appliances (costly returns), anything that heats, and fireplace units of any kind.
 * Only fireplace ACCESSORIES (wood racks, tools, logs, screens) remain in that area.
 */
export function isAppliance(type: string, title: string): boolean {
  if (/Appliances|Smart Toilets|Heaters?|Electric Fireplaces?/i.test(type)) return true;
  if (/réfrigérateur|frigo|laveuse|sécheuse|congélateur|déshumidificateur|climatiseur|lave-vaisselle/i.test(title)) return true;
  // Anything that heats — but « bois de chauffage » / firewood is the wood, not a heater (wood racks must stay).
  const heatText = title.replace(/bois de chauffage|firewood/gi, "");
  if (/chauffage|chauffant|heater|radiateur/i.test(heatText)) return true;
  // A fireplace sold as furniture elsewhere (« Meuble TV foyer électrique ») is still a fireplace unit.
  if (/foyer|chemin[ée]e/i.test(title) && /[ée]lectri|encastr|flamme/i.test(title)) return true;
  // A title that STARTS with a unit word is the unit itself (« Foyer extérieur 3-en-1 avec grille… »), whatever
  // accessory words follow; « Ensemble d'outils pour foyer » starts otherwise and stays an accessory.
  const startsAsUnit = /^\s*(foyer|po[êe]le|chemin[ée]e|insert|fireplace|stove)\b/i.test(title);
  if (FIRE_AREA.test(type)) {
    if (POWERED.test(title) || startsAsUnit) return true;
    if (FIRE_ACCESSORY.test(title)) return false;
    if (FIRE_UNIT.test(title)) return true;
  } else if (/foyer|chemin[ée]e|po[êe]le [àa]/i.test(title.replace(/pour (le )?foyer/gi, "")) && !FIRE_ACCESSORY.test(title)) {
    // Outside the fireplace area a fireplace word means furniture with a fireplace (« Meuble TV cheminée »): no.
    return true;
  }
  // "Électrique" alone is NOT an appliance elsewhere (kids' ride-on cars, filing cabinets with outlets, lift chairs).
  return false;
}

/** Colour families so a black armchair gets a black side table first. */
export function colourFamily(c: string | null | undefined): string | null {
  const s = String(c ?? "").toLowerCase().trim();
  if (!s) return null;
  if (/black|noir|espresso|charcoal|dark grey|dark gray|gris foncé/.test(s)) return "dark";
  if (/white|blanc|cream|crème|beige|ivory|ivoire/.test(s)) return "light";
  if (/oak|walnut|brown|brun|rustic|rustique|wood|bois|natur|teak|bamboo|bambou|chêne|noyer/.test(s)) return "wood";
  if (/grey|gray|gris/.test(s)) return "grey";
  return null;
}

/** The discount a variant can afford: 10 % or 5 % if we keep ≥ max(8 $, 8 %) after it and the card fees, else 0. */
export function discountTier(price: number, cost: number | null | undefined): number {
  if (!(price > 0) || typeof cost !== "number" || !(cost > 0)) return 0;
  for (const pct of TIERS) {
    const paid = price * (1 - pct / 100);
    if (netProfit(price, cost, pct / 100) >= Math.max(MIN_PROFIT_ABS, MIN_PROFIT_PCT * paid)) return pct;
  }
  return 0;
}

/**
 * The dollars the code takes off one unit: price × pct, rounded DOWN to the cent, so it never exceeds pct (the margin
 * guard flags anything above MAX_DISCOUNT) and the page shows exactly what checkout charges.
 */
export function discountAmount(price: number, pct: number): number {
  return Math.floor(price * pct + 1e-6) / 100;
}

export function discountedPrice(price: number, pct: number): number {
  return round2(price - discountAmount(price, pct));
}

/** Price cap for an add-on to an anchor at `anchorPrice`. */
export function priceCap(anchorPrice: number): number {
  return Math.min(anchorPrice, Math.max(anchorPrice * ANCHOR_SHARE, CAP_FLOOR));
}

/** The anchor = the most expensive line. */
export function anchorOf(lines: OrderLineInput[]): OrderLineInput | null {
  if (!lines.length) return null;
  return [...lines].sort((a, b) => b.price - a.price)[0];
}

export interface PickResult {
  anchor: OrderLineInput | null;
  rule: MapRule | null;
  picks: MerciPick[];
  /** Every product that passed the filters, best first (one variant each). The offer re-checks these live, in order. */
  ranked: MerciPick[];
  /** Distinct products that passed every filter (for coverage stats). */
  pool: number;
}

/** Main = the best; alternative = the best of a DIFFERENT product type. */
export function choosePair<T extends { type: string }>(ranked: T[]): T[] {
  const main = ranked[0];
  if (!main) return [];
  const alt = ranked.find((c) => c.type !== main.type);
  return alt ? [main, alt] : [main];
}

/**
 * Pick 1 main + 1 alternative of a different product type for this order, or nothing.
 * `anchorColour` comes from the catalogue when known (supplier colour), else the variant title is tried.
 */
export function pickOffers(lines: OrderLineInput[], catalogue: MerciCandidate[], opts: { now?: Date; anchorColour?: string | null } = {}): PickResult {
  const anchor = anchorOf(lines);
  if (!anchor) return { anchor: null, rule: null, picks: [], ranked: [], pool: 0 };
  const rule = ruleFor(anchor.productType);
  if (!rule) return { anchor, rule: null, picks: [], ranked: [], pool: 0 };

  const { month, day } = montrealDate(opts.now ?? new Date());
  const anchorType = normalizeType(anchor.productType);
  const aHead = leafHead(anchorType);
  const aFam = colourFamily(opts.anchorColour) ?? colourFamily(anchor.variantTitle);
  const orderPids = new Set(lines.map((l) => l.productId).filter(Boolean) as string[]);
  const orderTypes = new Set(lines.map((l) => normalizeType(l.productType)));
  const cap = priceCap(anchor.price);
  const anchorIsKids = /Kids|enfant/i.test(anchorType + " " + anchor.title);
  const anchorIsBath = /Bath/i.test(anchorType);

  type Scored = MerciCandidate & { score: number };
  // Every variant that passed, per product (a product can match several targets: keep its best score per variant).
  const byProduct = new Map<string, Map<string, Scored>>();
  rule.targets.forEach((target, rank) => {
    for (const c of catalogue) {
      if (!(c.pct > 0)) continue;
      const type = normalizeType(c.type);
      if (orderPids.has(c.productId)) continue;
      // Never the same type as anything in the order, never the same kind (no 2nd sofa / tree) — title targets ("~")
      // only widen what matches, they never lift these guards.
      if (orderTypes.has(type)) continue;
      if (aHead && leafHead(type) === aHead) continue;
      if (isAppliance(type, c.title) || outOfSeason(type, month, day)) continue;
      if (c.price < MIN_CANDIDATE_PRICE || c.price > cap) continue;
      if (!matchesTarget(type, c.title, target)) continue;
      if (!anchorIsKids && /enfant|kids/i.test(c.title + " " + type)) continue;
      if (!anchorIsBath && /salle de bain|anti-?bu[ée]e/i.test(c.title)) continue;
      const cf = colourFamily(c.colour);
      const score = rank * 10 + (aFam && cf && aFam === cf ? -4 : 0) + Math.abs(c.price / anchor.price - SWEET_SPOT) * 5;
      const variants = byProduct.get(c.productId) ?? new Map<string, Scored>();
      const prev = variants.get(c.variantId);
      if (!prev || score < prev.score) variants.set(c.variantId, { ...c, type, score });
      byProduct.set(c.productId, variants);
    }
  });

  const why = `Pour aller avec votre ${rule.noun}`;
  const strip = (x: Scored): MerciCandidate => {
    const { score, ...c } = x;
    void score;
    return c;
  };
  const byScore = (a: Scored, b: Scored) => a.score - b.score || a.price - b.price;
  const ranked: MerciPick[] = [...byProduct.values()]
    .map((variants) => [...variants.values()].sort(byScore))
    .sort((a, b) => byScore(a[0], b[0]))
    .map(([first, ...rest]) => {
      const c = strip(first);
      const siblings = rest.slice(0, SIBLINGS_KEPT).map(strip);
      return { ...c, why, discountedPrice: discountedPrice(c.price, c.pct), ...(siblings.length ? { siblings } : {}) };
    });
  return { anchor, rule, picks: choosePair(ranked), ranked, pool: ranked.length };
}
