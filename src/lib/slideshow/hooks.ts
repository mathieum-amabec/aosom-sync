/**
 * Marketing opening hooks for slideshow intro cards.
 *
 * The intro card must read like an ad, never the technical series id
 * ("best-sellers-1"). getSlideshowHook returns a catchy, rotation-randomized
 * line per content category; getSlogan refines an operator-provided emotional
 * seed into a punchy one-liner via Claude (with a safe fallback).
 */
import { getAnthropicClient } from "@/lib/content-generator";
import { CLAUDE } from "@/lib/config";

export type HookLanguage = "fr" | "en";

/** Catchy intro lines per content category (3-4 each, rotated at random). */
export const SLIDESHOW_HOOKS: Record<string, Record<HookLanguage, string[]>> = {
  best_sellers: {
    fr: [
      "🔥 Ce que tout le monde achète en ce moment",
      "👀 Les produits dont tout le monde parle",
      "⭐ Nos meilleurs vendeurs cette semaine",
    ],
    en: [
      "🔥 What everyone's buying right now",
      "👀 The products everyone's talking about",
      "⭐ This week's best sellers",
    ],
  },
  price_drops: {
    fr: [
      "💸 Prix cassés — stocks limités",
      "📉 Ces prix ne dureront pas longtemps",
      "🤑 Les meilleures aubaines du moment",
    ],
    en: [
      "💸 Slashed prices — limited stock",
      "📉 These prices won't last",
      "🤑 The best deals right now",
    ],
  },
  seasonal_ete: {
    fr: [
      "☀️ Prêt pour l'été québécois ?",
      "🌿 Ta terrasse mérite mieux",
      "🏡 L'été commence ici",
    ],
    en: [
      "☀️ Ready for summer?",
      "🌿 Your patio deserves better",
      "🏡 Summer starts here",
    ],
  },
  low_stock: {
    fr: [
      "⚠️ Presque épuisé — dépêche-toi",
      "🔥 Dernière chance avant rupture",
      "⏰ Il en reste peu !",
    ],
    en: [
      "⚠️ Almost gone — hurry",
      "🔥 Last chance before they're gone",
      "⏰ Only a few left!",
    ],
  },
  top3: {
    fr: [
      "🏆 Top 3 à ne pas manquer",
      "👑 Les 3 articles que tout le monde veut",
      "🎯 3 produits, 3 bonnes raisons d'acheter",
    ],
    en: [
      "🏆 Top 3 you can't miss",
      "👑 The 3 items everyone wants",
      "🎯 3 products, 3 reasons to buy",
    ],
  },
  kids_cars: {
    fr: [
      "🚗 Vroom vroom ! Les kids vont adorer",
      "🏎️ Pour les petits pilotes en herbe",
      "⚡ Les jouets dont ils rêvent !",
    ],
    en: [
      "🚗 Vroom vroom! Kids will love these",
      "🏎️ For little drivers in the making",
      "⚡ The toys they dream of!",
    ],
  },
  kids_toys: {
    fr: [
      "🎮 Des heures de plaisir garanties",
      "🌟 Les jouets préférés des enfants",
      "🎁 Idée cadeau parfaite",
    ],
    en: [
      "🎮 Hours of guaranteed fun",
      "🌟 Kids' favorite toys",
      "🎁 The perfect gift idea",
    ],
  },
  wow_discovery: {
    fr: [
      "✨ Tu ne connaissais pas ces produits...",
      "😍 Des trouvailles que tu vas adorer",
      "🔍 Nos coups de cœur cachés",
    ],
    en: [
      "✨ You didn't know these existed...",
      "😍 Finds you're going to love",
      "🔍 Our hidden gems",
    ],
  },
  office: {
    fr: [
      "💼 Ton bureau mérite une mise à jour",
      "🖥️ Travaille mieux, travaille confortablement",
      "✨ Transforme ton espace de travail",
    ],
    en: [
      "💼 Your office deserves an upgrade",
      "🖥️ Work better, work comfortably",
      "✨ Transform your workspace",
    ],
  },
};

/** Random integer in [0, n). Module-scoped so callers can't desync the rotation. */
function randIndex(n: number): number {
  return Math.floor(Math.random() * n);
}

/**
 * A catchy intro hook for a content category, never the technical series id.
 * `key` is a hook category (e.g. "best_sellers", "top3", "seasonal_ete"); for a
 * seasonal series pass `seasonal_${theme}` and it falls back to plain seasonal_ete.
 * Unknown keys fall back to the best_sellers set so a card is never empty.
 */
export function getSlideshowHook(key: string, language: HookLanguage = "fr"): string {
  const set =
    SLIDESHOW_HOOKS[key] ?? (key.startsWith("seasonal_") ? SLIDESHOW_HOOKS.seasonal_ete : undefined);
  const pool = (set ?? SLIDESHOW_HOOKS.best_sellers)[language];
  return pool[randIndex(pool.length)];
}

/**
 * Refine an operator-provided emotional seed into a punchy one-line slogan via
 * Claude. Returns the seed unchanged on any failure (empty/refused/non-text
 * response, API error, no key) — a slogan must never block a render.
 */
export async function getSlogan(seed: string, language: HookLanguage = "fr"): Promise<string> {
  const trimmed = seed.trim();
  if (!trimmed) return trimmed;
  const lang = language === "en" ? "anglais" : "français";
  const prompt =
    `Reformule cette idée en UN slogan publicitaire court et accrocheur en ${lang} ` +
    `(max 60 caractères, 1 emoji max, ton chaleureux, tutoiement). ` +
    `Réponds UNIQUEMENT avec le slogan, sans guillemets. Idée : ${trimmed}`;
  try {
    const message = await getAnthropicClient().messages.create({
      model: CLAUDE.MODEL,
      max_tokens: CLAUDE.MAX_TOKENS_SOCIAL,
      messages: [{ role: "user", content: prompt }],
    });
    const block = message.content[0];
    if (!block || block.type !== "text") return trimmed;
    const text = block.text.trim().replace(/^["']+|["']+$/g, "").trim();
    return text || trimmed;
  } catch {
    return trimmed;
  }
}
