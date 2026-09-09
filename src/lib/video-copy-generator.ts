/**
 * Per-SKU ad copy for sequential video ads, written by Claude Haiku.
 *
 * WHY THIS EXISTS
 * `CAMPAIGN_COPY` in render-sequential-ads.mts gives every product in a campaign the SAME
 * four lines. Twenty-nine autumn ads all opened on "TON INTÉRIEUR AVANT LES PREMIERS FROIDS",
 * which reads as a template the third time a shopper scrolls past it. This writes one hook
 * per SKU from the product's own title, price and category.
 *
 * Haiku, not Sonnet: four short lines from three known facts is not a reasoning task, and at
 * one call per clip the cost difference is the whole point. Runs on the `batch` pool.
 *
 * NEVER TWICE THE SAME HOOK
 * `generateVideoCopy` takes the hooks already used in this campaign and both tells the model
 * to avoid them AND rejects a duplicate after the fact (`usedHooks`). The instruction alone
 * is not enough — models converge on the same phrasing for similar products, which is exactly
 * the failure this module exists to prevent.
 */
import { getAnthropicClient } from "@/lib/content-generator";
import { budgetedCreate } from "@/lib/llm-budget";
import { cleanSocialCaption } from "@/lib/strip-markdown";

/** What the renderer knows about a product when it asks for copy. */
export interface CopyProduct {
  sku: string;
  /** Curated FR title (from Shopify, never the raw English feed name). */
  title: string;
  /** CAD. Omitted when unknown — the price line is then dropped rather than faked. */
  price?: number | null;
  /** Aosom product_type, for category flavour. */
  productType?: string | null;
}

export interface VideoCopy {
  /** Exactly 4 messages: hook, benefit, price, CTA. */
  messages: [string, string, string, string];
  /** The hook alone, for the 0.8 s visual opener and for duplicate tracking. */
  hook: string;
  /** True when the model failed and the deterministic fallback was used. */
  fallback: boolean;
}

/**
 * Campaign angle. The brief fixes these three; anything else gets the neutral angle rather
 * than a wrong one, since a made-up angle is worse than a plain one.
 */
export const CAMPAIGN_ANGLE: Record<string, string> = {
  "automne-2026": "le confort de l'intérieur quand le froid arrive",
  "hiver-2026": "le cadeau des fêtes, quelque chose qu'on garde",
  "animaux-2026": "le bonheur et le confort de l'animal de la maison",
  "maison-2026": "la pièce qu'on remet à plus tard depuis des mois",
  "enfants-2026": "ce que les enfants réclament sans arrêt",
  "noel-2026": "le cadeau de Noël livré à temps",
  "halloween-2026": "l'effet sur les voisins le soir de l'Halloween",
};
export const NEUTRAL_ANGLE = "le produit lui-même, sans référence saisonnière";

const FREE_SHIPPING = "LIVRAISON GRATUITE PARTOUT AU CANADA";
const CTA = "MAGASINEZ SUR AMEUBLODIRECT.CA";

/** CAD in the Quebec format the rest of the pipeline renders (156,99 $). */
export function priceFr(n: number): string {
  return new Intl.NumberFormat("fr-CA", {
    style: "currency",
    currency: "CAD",
    currencyDisplay: "narrowSymbol",
  })
    .format(n)
    .replace(/ | /g, " ");
}

function systemPrompt(angle: string, avoid: string[]): string {
  return [
    "Tu écris des pubs vidéo courtes en français québécois pour une boutique de meubles en ligne.",
    "",
    "Structure Hormozi, 4 messages séquentiels affichés à l'écran :",
    "  1. HOOK (0-3 s) — la douleur ou la frustration, en 6 mots max. Percutant, jamais générique.",
    "  2. BÉNÉFICE (3-8 s) — le désir : ce que la personne obtient. 8 mots max.",
    "  3. PRIX (8-12 s) — le prix exact fourni, avec la livraison gratuite.",
    "  4. CTA (12-15 s) — l'appel à l'action.",
    "",
    `Angle de la campagne : ${angle}.`,
    "",
    "Règles strictes :",
    "- MAJUSCULES pour les 4 messages.",
    "- Le hook doit être propre à CE produit : parle de son usage réel, pas d'une catégorie.",
    "- Jamais de nom de fournisseur (Aosom, Outsunny, HOMCOM, PawHut, Vinsetto, Qaba).",
    "- Pas de promesse invérifiable (qualité garantie, meilleur prix, etc.).",
    "- Pas d'emoji, pas de ponctuation finale, pas de guillemets.",
    avoid.length
      ? `- INTERDIT de réutiliser ou de paraphraser ces hooks déjà pris : ${avoid.map((h) => `"${h}"`).join(", ")}`
      : "",
    "",
    'Réponds UNIQUEMENT en JSON : {"hook":"...","benefit":"...","price":"...","cta":"..."}',
  ]
    .filter(Boolean)
    .join("\n");
}

function userPrompt(p: CopyProduct): string {
  const lines = [`Produit : ${p.title}`, `SKU : ${p.sku}`];
  if (typeof p.price === "number" && Number.isFinite(p.price)) lines.push(`Prix : ${priceFr(p.price)}`);
  if (p.productType) lines.push(`Catégorie : ${p.productType}`);
  return lines.join("\n");
}

/** Uppercase, strip markdown/quotes/emoji, collapse spaces, drop trailing punctuation. */
export function normalizeLine(s: string): string {
  return cleanSocialCaption(String(s ?? ""))
    .replace(/["'“”«»]/g, "")
    .replace(/[\p{Extended_Pictographic}]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?;:,]+$/, "")
    .trim()
    .toUpperCase();
}

/**
 * Deterministic copy, used when the model fails or returns something unusable.
 *
 * Not a generic slate: it still varies by campaign angle and still carries the product's own
 * price, so a fallback ad is weaker than a written one but never wrong or interchangeable.
 */
export function fallbackCopy(p: CopyProduct, campaign: string): VideoCopy {
  const hookByCampaign: Record<string, string> = {
    "automne-2026": "TON INTÉRIEUR AVANT LES PREMIERS FROIDS",
    "hiver-2026": "LE CADEAU QU'IL VA VRAIMENT GARDER",
    "animaux-2026": "TON ANIMAL MÉRITE MIEUX QUE LE PLANCHER",
    "maison-2026": "LA PIÈCE QUE TU REPOUSSES DEPUIS DES MOIS",
    "enfants-2026": "CE QU'ILS VONT DEMANDER 100 FOIS",
  };
  const hook = hookByCampaign[campaign] ?? normalizeLine(p.title).slice(0, 40);
  const priceLine =
    typeof p.price === "number" && Number.isFinite(p.price)
      ? `${priceFr(p.price)} LIVRÉ CHEZ VOUS`
      : FREE_SHIPPING;
  return {
    messages: [hook, normalizeLine(p.title).slice(0, 48), priceLine, CTA],
    hook,
    fallback: true,
  };
}

export interface GenerateOptions {
  /** Hooks already used in this campaign. A repeat is rejected and retried once. */
  usedHooks?: string[];
  /** Seam for tests: returns the raw model text. */
  complete?: (system: string, user: string) => Promise<string>;
  model?: string;
}

async function defaultComplete(system: string, user: string, model: string): Promise<string> {
  const res = await budgetedCreate(getAnthropicClient(), {
    model,
    max_tokens: 400,
    system,
    messages: [{ role: "user", content: user }],
  });
  return res.content.map((c) => ("text" in c ? c.text : "")).join("");
}

/** Parse the model's JSON into four normalized lines. Returns null when unusable. */
export function parseCopyReply(text: string, p: CopyProduct): VideoCopy | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const hook = normalizeLine(String(obj.hook ?? ""));
  const benefit = normalizeLine(String(obj.benefit ?? ""));
  let price = normalizeLine(String(obj.price ?? ""));
  const cta = normalizeLine(String(obj.cta ?? "")) || CTA;
  if (!hook || !benefit) return null;

  // The price line is the one message that must not be improvised: if the model dropped the
  // figure, rebuild it from the product rather than shipping a price-less price slide.
  const hasPrice = typeof p.price === "number" && Number.isFinite(p.price);
  if (hasPrice && !/\d/.test(price)) price = `${priceFr(p.price as number)} LIVRÉ CHEZ VOUS`;
  if (!price) price = hasPrice ? `${priceFr(p.price as number)} LIVRÉ CHEZ VOUS` : FREE_SHIPPING;

  return { messages: [hook, benefit, price, cta], hook, fallback: false };
}

/**
 * Write four unique messages for one product.
 *
 * Retries once when the hook collides with `usedHooks`, then falls back. Never throws — a
 * campaign of 29 clips must not die on the twelfth because one completion came back malformed.
 */
export async function generateVideoCopy(
  product: CopyProduct,
  campaign: string,
  opts: GenerateOptions = {},
): Promise<VideoCopy> {
  const angle = CAMPAIGN_ANGLE[campaign] ?? NEUTRAL_ANGLE;
  const used = (opts.usedHooks ?? []).map((h) => normalizeLine(h));
  const model = opts.model ?? "claude-haiku-4-5";
  const complete = opts.complete ?? ((s: string, u: string) => defaultComplete(s, u, model));

  for (let attempt = 0; attempt < 2; attempt++) {
    // On the retry, hand back the hook that just collided as well — otherwise the model has
    // no signal that its own last answer was the problem.
    const avoid = attempt === 0 ? used : used.slice();
    try {
      const text = await complete(systemPrompt(angle, avoid), userPrompt(product));
      const copy = parseCopyReply(text, product);
      if (!copy) continue;
      if (used.includes(copy.hook)) {
        used.push(copy.hook);
        continue;
      }
      return copy;
    } catch {
      // Fall through to the next attempt, then to the deterministic copy.
    }
  }
  return fallbackCopy(product, campaign);
}
