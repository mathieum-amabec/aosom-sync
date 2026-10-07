/**
 * The weekly calendar and the product pickers behind each format. A picker returns null when it
 * cannot assemble a post that passes every live gate; the runner then tries the fallback chain,
 * so a day is never left empty and a weak post is never forced.
 */
import type { Row } from "@libsql/client";
import { getSelectorDb } from "@/lib/selectors/db";
import { compareAtSubquery } from "@/lib/selectors/map";
import { verifyUntil } from "./live";
import type { Candidate, FormatId, LiveProduct, PlannedPost, SlotName } from "./types";

export const TIMEZONE = "America/Toronto";

export interface LocalDay {
  /** YYYY-MM-DD in Toronto. */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Whole weeks since 1970 — a stable rotation counter. */
  week: number;
  /** Whole days since 1970 — a stable daily rotation counter. */
  dayIndex: number;
  /** 1–12. */
  month: number;
}

export function localDay(now: Date, tz: string = TIMEZONE): LocalDay {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now)) parts[p.type] = p.value;
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  const dayIndex = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(), week: Math.floor((dayIndex + 4) / 7), dayIndex, month: m };
}

/** Morning format per weekday (0 = Sunday). */
export const MORNING_FORMAT: Record<number, FormatId> = {
  1: "nouveautes", 2: "baisses", 3: "piece", 4: "ab", 5: "top-ventes", 6: "astuce", 0: "coeur",
};

export function plannedFormat(day: LocalDay, slot: SlotName): FormatId {
  return slot === "afternoon" ? "vedette" : MORNING_FORMAT[day.weekday];
}

/** When a morning format cannot be built, try these in order (never itself). */
export const FALLBACKS: FormatId[] = ["top-ventes", "piece", "vedette"];

// ── Candidate queries ──────────────────────────────────────────────────────

const BASE = `
  SELECT p.sku AS sku, p.name AS name, p.qty AS qty, p.product_type AS product_type,
         p.shopify_product_id AS shopify_product_id, COALESCE(v.u, 0) AS velocity
  FROM products p
  LEFT JOIN (
    SELECT sku, SUM(CASE WHEN old_qty > new_qty THEN old_qty - new_qty ELSE 0 END) AS u
    FROM price_history
    WHERE change_type = 'stock_change' AND detected_at > cast(strftime('%s','now','-14 days') as integer)
    GROUP BY sku
  ) v ON v.sku = p.sku`;

// Not decor: the Kitchen & Dining branch also holds janitorial carts and mop buckets.
const NOT_DECOR = ["Mop", "Janitorial", "Trash", "Rubbish", "Garbage", "Wringer"].map((w) => `AND p.name NOT LIKE '%${w}%'`).join(" ");
const LIVE_ONLY = `p.shopify_product_id IS NOT NULL AND p.shopify_product_id != '' AND p.qty > 0 ${NOT_DECOR}`;

/** Oct–Apr: patio furniture is out of season (fire pits and heaters stay). */
const SUMMER_NAMES = ["Sandbox", "Pool", "Sprinkler", "Hammock", "Gazebo", "Parasol", "Umbrella", "Bike Trailer", "Paddling", "Splash", "Swing", "Trampoline", "Cooler", "Beach"];
function seasonClause(month: number): string {
  const winter = month >= 10 || month <= 4;
  if (!winter) return "";
  const names = SUMMER_NAMES.map((w) => `AND p.name NOT LIKE '%${w}%'`).join(" ");
  return `AND (p.product_type NOT LIKE 'Patio & Garden%' OR p.product_type LIKE '%Fire Pit%' OR p.product_type LIKE '%Heater%') ${names}`;
}

function toCandidate(row: Row): Candidate {
  const o = row as unknown as Record<string, unknown>;
  return {
    sku: String(o.sku ?? ""),
    shopifyProductId: String(o.shopify_product_id ?? ""),
    nameEn: String(o.name ?? ""),
    productType: String(o.product_type ?? ""),
    stock: Number(o.qty ?? 0),
    velocity: Number(o.velocity ?? 0),
  };
}

async function candidates(where: string, args: (string | number)[], order: string, limit: number, month: number, extraJoin = ""): Promise<Candidate[]> {
  const db = await getSelectorDb();
  const r = await db.execute({ sql: `${BASE} ${extraJoin} WHERE ${LIVE_ONLY} ${seasonClause(month)} ${where} ORDER BY ${order} LIMIT ?`, args: [...args, limit] });
  return r.rows.map(toCandidate);
}

const leaf = (productType: string) => productType.split(">").pop()?.trim().toLowerCase() ?? productType.toLowerCase();

// ── Rotations (code-owned content: nothing here is invented by the model) ──

export const ROOMS: Array<{ fr: string; en: string; pattern: string }> = [
  { fr: "le salon", en: "the living room", pattern: "%Living Room Furniture%" },
  { fr: "la chambre", en: "the bedroom", pattern: "%Bedroom Furniture%" },
  { fr: "le bureau à la maison", en: "the home office", pattern: "%Office Furniture%" },
  { fr: "la cuisine et la salle à manger", en: "the kitchen and dining room", pattern: "%Kitchen & Dining Furniture%" },
  { fr: "l'entrée et le rangement", en: "the entryway and storage", pattern: "%Storage & Organization%" },
];

export const AB_LEAVES = ["%Coffee Tables%", "%Accent Chairs%", "%Bedside%", "%Computer Desks%", "%Sofas%", "%Storage Cabinets%"];

/** Verified measuring rules (same ones as the Studio "Ameublo mesure" videos). */
export const RULES: Array<{ key: string; pattern: string; fr: string; en: string }> = [
  { key: "coffee", pattern: "%Coffee Tables%", fr: "Garde 40 à 45 cm entre le canapé et la table basse, et choisis une table longue des 2/3 du canapé.", en: "Keep 16 to 18 inches between the sofa and the coffee table, and pick a table 2/3 the length of the sofa." },
  { key: "bedside", pattern: "%Bedside%", fr: "Une table de chevet à la hauteur du matelas (à 5 cm près), avec 60 cm pour passer à côté du lit.", en: "A nightstand at mattress height (within 2 inches), with 24 inches to walk past the bed." },
  { key: "dining", pattern: "%Dining%", fr: "Prévois 90 cm entre la table et le mur, et 60 cm par personne.", en: "Allow 36 inches between the table and the wall, and 24 inches per person." },
  { key: "desk", pattern: "%Computer Desks%", fr: "L'écran à un bras de distance (50 à 70 cm), le haut de l'écran à la hauteur des yeux.", en: "Screen an arm's length away (20 to 28 inches), top of the screen at eye level." },
  { key: "stools", pattern: "%Stool%", fr: "Garde 25 à 30 cm entre l'assise et le comptoir: pour un comptoir de 91 cm, un tabouret de 61 à 66 cm.", en: "Keep 10 to 12 inches between seat and countertop: for a 36-inch counter, a 24 to 26-inch stool." },
];

export const FEATURED_CATEGORIES = [
  "%Sofas%", "%Accent Chairs%", "%Bedside%", "%Office Chairs%", "%Storage Cabinets%", "%Coffee Tables%", "%Computer Desks%",
  "%Bar Cabinets%", "%Dressing & Vanity%", "%Pet Supplies%", "%Storage Ottomans%", "%Kids Furniture%",
];

const HEART_CATEGORIES = ["%Sofas%", "%Accent Chairs%", "%Beds%", "%Dressing & Vanity%", "%Storage Ottomans%", "%Pet Supplies%", "%Bedside%"];

// ── Pickers ────────────────────────────────────────────────────────────────

export interface PickCtx {
  day: LocalDay;
  /** SKUs still in their repost cooldown. */
  skip: Set<string>;
}

type Picker = (ctx: PickCtx) => Promise<PlannedPost | null>;

const post = (format: FormatId, label: string, products: LiveProduct[], maxProducts: number, topic?: PlannedPost["topic"]): PlannedPost => ({ format, label, products, maxProducts, topic });

const nouveautes: Picker = async ({ day, skip }) => {
  const c = await candidates(
    `AND ij.shopify_id IS NOT NULL AND datetime(ij.updated_at) >= datetime('now','-14 days')`, [], "ij.updated_at DESC", 30, day.month,
    `JOIN import_jobs ij ON ij.shopify_id = p.shopify_product_id`,
  );
  const items = await verifyUntil(c, 5, skip, undefined, "nouveautes", true);
  return items.length >= 3 ? post("nouveautes", "Nouveautés de la semaine", items, 5) : null;
};

const baisses: Picker = async ({ day, skip }) => {
  const c = await candidates(
    `AND ${compareAtSubquery("p")} >= p.price * 1.1`, [], `(${compareAtSubquery("p")} - p.price) / p.price DESC`, 30, day.month,
  );
  // The DB's derived compare-at is only a shortlist: Shopify must carry a real ≥10 % rabais too.
  const items = await verifyUntil(c, 5, skip, (p) => p.compareAt != null, "baisses", true);
  return items.length >= 3 ? post("baisses", "Prix en baisse", items, 5) : null;
};

const piece: Picker = async ({ day, skip }) => {
  for (let i = 0; i < ROOMS.length; i++) {
    const room = ROOMS[(day.week + i) % ROOMS.length];
    const c = await candidates(`AND p.product_type LIKE ?`, [room.pattern], "velocity DESC, p.qty DESC", 40, day.month);
    const used = new Set<string>();
    const items = await verifyUntil(c, 4, skip, (p) => {
      const l = leaf(p.productType);
      if (used.has(l)) return false; // one piece per type: a room, not four sofas
      used.add(l);
      return true;
    });
    if (items.length >= 3) return post("piece", `La pièce complète: ${room.fr}`, items, 4, { fr: room.fr, en: room.en });
  }
  return null;
};

const ab: Picker = async ({ day, skip }) => {
  for (let i = 0; i < AB_LEAVES.length; i++) {
    const pattern = AB_LEAVES[(day.week + i) % AB_LEAVES.length];
    const c = await candidates(`AND p.product_type LIKE ?`, [pattern], "velocity DESC, p.qty DESC", 14, day.month);
    const items = await verifyUntil(c, 2, skip, (p, picked) => {
      if (picked.length === 0) return true;
      const a = picked[0];
      const ratio = Math.max(a.price, p.price) / Math.min(a.price, p.price);
      return ratio <= 2.5 && p.titleFr.toLowerCase() !== a.titleFr.toLowerCase(); // comparable, not twins
    });
    if (items.length === 2) return post("ab", "A ou B?", items, 2);
  }
  return null;
};

const topVentes: Picker = async ({ day, skip }) => {
  const c = await candidates(`AND COALESCE(v.u, 0) > 0`, [], "velocity DESC", 40, day.month);
  const perLeaf = new Map<string, number>();
  const items = await verifyUntil(c, 5, skip, (p) => {
    const l = leaf(p.productType);
    const n = perLeaf.get(l) ?? 0;
    if (n >= 2) return false;
    perLeaf.set(l, n + 1);
    return true;
  });
  return items.length >= 3 ? post("top-ventes", "Les plus populaires cette semaine", items, 5) : null;
};

const astuce: Picker = async ({ day, skip }) => {
  for (let i = 0; i < RULES.length; i++) {
    const rule = RULES[(day.week + i) % RULES.length];
    const c = await candidates(`AND p.product_type LIKE ?`, [rule.pattern], "velocity DESC, p.qty DESC", 12, day.month);
    const items = await verifyUntil(c, 1, skip, undefined, "astuce");
    if (items.length === 1) return post("astuce", "Astuce déco", items, 1, { fr: rule.fr, en: rule.en });
  }
  return null;
};

const coeur: Picker = async ({ day, skip }) => {
  for (let i = 0; i < HEART_CATEGORIES.length; i++) {
    const pattern = HEART_CATEGORIES[(day.week + i) % HEART_CATEGORIES.length];
    const c = await candidates(`AND p.product_type LIKE ?`, [pattern], "velocity DESC, p.qty DESC", 12, day.month);
    const items = await verifyUntil(c, 1, skip, undefined, "coeur");
    if (items.length === 1) return post("coeur", "Coup de cœur", items, 1);
  }
  return null;
};

const vedette: Picker = async ({ day, skip }) => {
  for (let i = 0; i < FEATURED_CATEGORIES.length; i++) {
    const pattern = FEATURED_CATEGORIES[(day.dayIndex + i) % FEATURED_CATEGORIES.length];
    const c = await candidates(`AND p.product_type LIKE ?`, [pattern], "velocity DESC, p.qty DESC", 12, day.month);
    const items = await verifyUntil(c, 1, skip, undefined, "vedette");
    if (items.length === 1) return post("vedette", "Produit vedette", items, 1);
  }
  return null;
};

export const PICKERS: Record<FormatId, Picker> = {
  nouveautes, baisses, piece, ab, "top-ventes": topVentes, astuce, coeur, vedette,
};
