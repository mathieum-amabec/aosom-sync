/**
 * Variant-photo guard (daily) — every colour of every multi-colour product shows ITS OWN photo, and its label does not
 * contradict the supplier's colour (Mat, 2026-10-18: "la pastille de couleur n'avait aucun rapport avec l'image").
 *
 * For each ACTIVE product with 2+ colours:
 *   - PHOTO (Aosom products, rule in variant-photos.ts): a colour with no photo, another colour's photo, or a photo
 *     shared with another colour gets its own exclusive feed photo — attached when it is already in the gallery,
 *     uploaded otherwise. Every variant of the colour gets the same photo (Dawn freezes on a variant without one).
 *     Live by default (`settings.variant_photo_guard_mode` = off | dry | live), capped per run.
 *   - STRUCTURE (Aosom and Costway): colours without a photo, or sharing one, are reported when they cannot be fixed.
 *   - LABEL (Aosom): the colour label against the feed colour of its SKU; a contradiction (« Rose » for a Gray SKU) is
 *     reported, never renamed automatically — the photo decides, a human confirms.
 * Findings that need a human go to one dashboard notification « Couleurs à vérifier ».
 */
import { shopifyFetch, parseLinkHeader } from "@/lib/shopify-client";
import { createNotification, ensureSchema, getSetting } from "@/lib/database";
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import { toFrenchColour } from "@/lib/colour-names";
import { planColourPhotos, type ColourPhotoAction, type ColourSource } from "@/lib/variant-photos";

export const VARIANT_PHOTO_GUARD_MODE_KEY = "variant_photo_guard_mode";
export type GuardMode = "off" | "dry" | "live";
/** Shopify writes per run (a variant PUT or an image upload each). */
export const MAX_FIXES_PER_RUN = 150;

const COLOUR_OPT = /^(couleur|color|colour|coloris)$/i;

// ─── Colour families (label vs feed) ────────────────────────────────────────────

const FAMILIES: Record<string, string[]> = {
  black: ["noir", "black", "ebony", "ébène"],
  white: ["blanc", "white", "crème", "creme", "cream", "ivoire", "ivory"],
  grey: ["gris", "grey", "gray", "argent", "silver", "charcoal", "charbon", "anthracite", "acier", "steel", "carbone", "carbon", "graphite", "slate", "ardoise"],
  brown: ["brun", "brown", "café", "cafe", "coffee", "noyer", "walnut", "chêne", "chene", "oak", "espresso", "teak", "teck", "bois", "wood", "naturel", "natural", "chestnut", "rustic", "rustique", "acajou", "mahogany", "bambou", "bamboo", "rotin", "rattan", "cognac", "marron", "chocolat", "chocolate", "pin", "pine", "cerisier", "cherry", "taupe"],
  beige: ["beige", "kaki", "khaki", "sable", "sand", "tan", "taupe", "lin", "linen", "crème", "creme", "cream", "naturel", "natural", "champagne", "ivoire", "ivory", "oatmeal", "avoine"],
  blue: ["bleu", "blue", "navy", "marine", "turquoise", "teal", "sarcelle", "cyan", "aqua"],
  green: ["vert", "green", "olive", "sauge", "sage", "menthe", "mint", "kaki", "khaki", "teal", "sarcelle"],
  red: ["rouge", "red", "bordeaux", "burgundy", "vin", "wine", "cerise", "cherry"],
  pink: ["rose", "pink", "fuchsia", "magenta", "blush"],
  yellow: ["jaune", "yellow", "moutarde", "mustard", "or", "gold", "doré", "dore", "golden", "earthy"],
  orange: ["orange", "corail", "coral", "cuivre", "copper", "rouille", "rust", "terracotta", "bronze"],
  purple: ["violet", "purple", "mauve", "lavande", "lavender", "lilas", "lilac", "prune", "plum"],
};

/** Colour families a label belongs to (by whole words). Empty = unknown (pattern, multicolour, transparent…). */
export function colourFamilies(label: string): Set<string> {
  const words = (label || "").toLowerCase().split(/[^a-zà-ÿ]+/).filter(Boolean);
  const out = new Set<string>();
  for (const [fam, keys] of Object.entries(FAMILIES)) if (words.some((w) => keys.includes(w))) out.add(fam);
  if (words.some((w) => ["multicolore", "multicolour", "multi", "mixed", "mixte", "coloré", "colored", "colourful", "assorted", "assorti"].includes(w))) out.clear();
  return out;
}

/** True when the shown label and the supplier colour name no colour in common (both known). */
export function labelContradicts(label: string, feedColour: string): boolean {
  const a = colourFamilies(label);
  const b = colourFamilies(feedColour);
  if (a.size === 0 || b.size === 0) return false;
  for (const f of a) if (b.has(f)) return false;
  return true;
}

// ─── Per-product plan (pure) ─────────────────────────────────────────────────────

export interface ShopProduct {
  id: number;
  handle: string;
  tags: string;
  options: Array<{ name: string; position: number; values: string[] }>;
  variants: Array<{ id: number; sku: string; option1?: string | null; option2?: string | null; option3?: string | null; image_id: number | null }>;
  images: Array<{ id: number; src: string }>;
}

export interface FeedInfo {
  color: string;
  images: string[];
  /** Aosom product group (PSIN), to find a renamed SKU of the same product. */
  psin?: string;
}

export interface ProductPlan {
  productId: number;
  handle: string;
  source: "aosom" | "costway";
  actions: Array<ColourPhotoAction & { variantIds: number[] }>;
  labelIssues: Array<{ colour: string; sku: string; feedColour: string }>;
}

/**
 * `feed` holds Aosom SKUs (supplier feed) AND Costway internal SKUs (costway_products images): both suppliers give each
 * colour its own photo. A Costway gallery uses neutral file names, so its current photos are never recognised as a
 * feed file — only a missing or shared photo is replaced (by uploading the colour's own supplier photo).
 */
export function planProduct(
  p: ShopProduct,
  feed: ReadonlyMap<string, FeedInfo>,
  psinIndex?: ReadonlyMap<string, Array<{ sku: string; color: string; images: string[] }>>,
): ProductPlan | null {
  const opt = p.options.find((o) => COLOUR_OPT.test(o.name.trim()));
  if (!opt || opt.values.length < 2) return null;
  const key = `option${opt.position}` as "option1" | "option2" | "option3";
  const source = /(^|,\s*)src-c(\s*,|$)/.test(p.tags) ? "costway" : "aosom";
  const byColour = new Map<string, ShopProduct["variants"]>();
  for (const v of p.variants) {
    const c = String(v[key] ?? "");
    if (!byColour.has(c)) byColour.set(c, []);
    byColour.get(c)!.push(v);
  }
  const colours = [...byColour.entries()].map(([colour, vs]) => {
    const ids = new Set(vs.map((v) => v.image_id));
    // Variants of one colour that disagree count as "no photo": they all get the colour's own.
    return { colour, currentImageId: ids.size === 1 ? vs[0].image_id : null };
  });
  // A colour whose SKUs all left the feed is usually still sold by Aosom under a renamed SKU (suffix corrected, see
  // memory "Aosom renames SKU suffixes"). Its photo is then found in the same Aosom product group (PSIN): the
  // group's SKU that is not on this product and carries the same colour. Without this, such a colour kept another
  // colour's photo (audit 2026-10-18: most of the "photo has nothing to do with the swatch" cases).
  const ownSkus = new Set(p.variants.map((v) => v.sku));
  const psins = new Set(p.variants.map((v) => feed.get(v.sku)?.psin).filter((x): x is string => !!x));
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+\d+$/, "").trim();
  const sources: ColourSource[] = [...byColour.entries()].map(([colour, vs]) => {
    const images = vs.flatMap((v) => feed.get(v.sku)?.images ?? []);
    if (images.length || !psinIndex || !psins.size) return { colour, images };
    for (const psin of psins) {
      const twin = (psinIndex.get(psin) ?? []).find((r) => !ownSkus.has(r.sku) && norm(toFrenchColour(r.color)) === norm(colour));
      if (twin) return { colour, images: twin.images };
    }
    return { colour, images };
  });
  const actions = planColourPhotos(colours, sources, p.images).map((a) => ({ ...a, variantIds: byColour.get(a.colour)!.map((v) => v.id) }));
  const labelIssues: ProductPlan["labelIssues"] = [];
  // "Défaut" = a variant created without a colour next to coloured siblings (2026-10-18: two Costway products whose
  // variants really differ by SIZE). It is never a colour a shopper can match to a photo.
  for (const [colour, vs] of byColour) if (/^d[ée]faut(\s+\d+)?$/i.test(colour.trim())) labelIssues.push({ colour, sku: vs[0].sku, feedColour: "(aucune couleur)" });
  if (source === "aosom") {
    for (const [colour, vs] of byColour) for (const v of vs) {
      const f = feed.get(v.sku);
      if (f?.color && labelContradicts(colour, toFrenchColour(f.color)) && labelContradicts(colour, f.color)) {
        labelIssues.push({ colour, sku: v.sku, feedColour: f.color });
      }
    }
  }
  return { productId: p.id, handle: p.handle, source, actions, labelIssues };
}

// ─── Wiring ─────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function loadActiveProducts(): Promise<ShopProduct[]> {
  const out: ShopProduct[] = [];
  let pageInfo: string | null = null;
  for (let i = 0; i < 100; i++) {
    const params = new URLSearchParams({ limit: "250", fields: "id,handle,tags,options,variants,images" });
    if (pageInfo) params.set("page_info", pageInfo);
    else params.set("status", "active");
    const res = await shopifyFetch(`/products.json?${params}`);
    if (!res.ok) throw new Error(`variant-photo-guard: products fetch failed ${res.status}`);
    out.push(...((await res.json()) as { products: ShopProduct[] }).products);
    pageInfo = parseLinkHeader(res.headers.get("Link"));
    if (!pageInfo) break;
    await sleep(500);
  }
  return out;
}

async function putVariantImage(variantId: number, imageId: number | string): Promise<void> {
  const res = await shopifyFetch(`/variants/${variantId}.json`, { method: "PUT", body: JSON.stringify({ variant: { id: variantId, image_id: Number(imageId) } }) });
  if (!res.ok) throw new Error(`variant ${variantId}: ${res.status}`);
}

/** Downloads the feed photo and uploads it as an attachment (Shopify's own fetch of the supplier CDN can be refused). */
async function uploadVariantImage(productId: number, url: string, variantIds: number[]): Promise<void> {
  const img = await fetch(url);
  if (!img.ok) throw new Error(`download ${url}: ${img.status}`);
  const attachment = Buffer.from(await img.arrayBuffer()).toString("base64");
  const filename = url.split("?")[0].split("/").pop() ?? "photo.jpg";
  const res = await shopifyFetch(`/products/${productId}/images.json`, { method: "POST", body: JSON.stringify({ image: { attachment, filename, variant_ids: variantIds } }) });
  if (!res.ok) throw new Error(`upload to ${productId}: ${res.status}`);
}

export interface VariantPhotoGuardReport {
  mode: GuardMode;
  multiColourProducts: number;
  fixed: number;
  pending: number;
  failed: string[];
  noSource: Array<{ handle: string; colour: string; reason: string }>;
  labelIssues: Array<{ handle: string; colour: string; sku: string; feedColour: string }>;
  notified: boolean;
}

export async function runVariantPhotoGuard(opts: { mode?: GuardMode; notify?: boolean; maxFixes?: number } = {}): Promise<VariantPhotoGuardReport> {
  const raw = opts.mode ?? (await getSetting(VARIANT_PHOTO_GUARD_MODE_KEY));
  const mode: GuardMode = raw === "off" || raw === "dry" ? raw : "live";
  const report: VariantPhotoGuardReport = { mode, multiColourProducts: 0, fixed: 0, pending: 0, failed: [], noSource: [], labelIssues: [], notified: false };
  if (mode === "off") return report;

  const [products, catalog] = await Promise.all([loadActiveProducts(), fetchAosomCatalog()]);
  const feed = new Map<string, FeedInfo>();
  const psinIndex = new Map<string, Array<{ sku: string; color: string; images: string[] }>>();
  for (const p of catalog) {
    feed.set(p.sku, { color: p.color, images: p.images, psin: p.psin || undefined });
    if (p.psin) { if (!psinIndex.has(p.psin)) psinIndex.set(p.psin, []); psinIndex.get(p.psin)!.push({ sku: p.sku, color: p.color, images: p.images }); }
  }
  const db = await ensureSchema();
  const cw = await db.execute(`SELECT internal_sku, color, images FROM costway_products WHERE internal_sku IS NOT NULL AND shopify_product_id IS NOT NULL`);
  for (const r of cw.rows) {
    let images: string[] = [];
    try { images = JSON.parse(String(r.images ?? "[]")); } catch { /* unreadable row: no source */ }
    feed.set(String(r.internal_sku), { color: String(r.color ?? ""), images });
  }
  const cap = opts.maxFixes ?? MAX_FIXES_PER_RUN;

  for (const p of products) {
    const plan = planProduct(p, feed, psinIndex);
    if (!plan) continue;
    report.multiColourProducts++;
    for (const l of plan.labelIssues) report.labelIssues.push({ handle: plan.handle, ...l });
    for (const a of plan.actions) {
      if (a.action === "ok") continue;
      if (a.action === "no-source") {
        report.noSource.push({ handle: plan.handle, colour: a.colour, reason: a.reason });
        continue;
      }
      if (mode !== "live" || report.fixed >= cap) { report.pending++; continue; }
      try {
        if (a.action === "attach") for (const vid of a.variantIds) { await putVariantImage(vid, a.imageId); await sleep(520); }
        else { await uploadVariantImage(plan.productId, a.url, a.variantIds); await sleep(520); }
        report.fixed++;
      } catch (err) {
        report.failed.push(`${plan.handle} « ${a.colour} »: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (opts.notify !== false && (report.noSource.length || report.labelIssues.length || report.failed.length || report.pending)) {
    const lines: string[] = [];
    if (report.fixed) lines.push(`${report.fixed} couleur(s) corrigée(s) automatiquement (photo de la bonne couleur).`);
    if (report.pending) lines.push(`${report.pending} correction(s) en attente (mode ${mode} ou plafond ${cap}/jour).`);
    if (report.labelIssues.length) lines.push(`${report.labelIssues.length} étiquette(s) de couleur qui contredisent le fournisseur — ` + report.labelIssues.slice(0, 6).map((l) => `${l.handle} « ${l.colour} » (fournisseur : ${l.feedColour})`).join(" ; "));
    if (report.noSource.length) lines.push(`${report.noSource.length} couleur(s) sans photo propre dans le flux — ` + report.noSource.slice(0, 6).map((n) => `${n.handle} « ${n.colour} » (${n.reason})`).join(" ; "));
    if (report.failed.length) lines.push(`${report.failed.length} échec(s) — ` + report.failed.slice(0, 4).join(" ; "));
    await createNotification("warning", "Couleurs à vérifier", lines.join("\n"));
    report.notified = true;
  }
  return report;
}
