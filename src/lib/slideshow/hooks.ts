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

/** Punchy clickbait intro lines per content category (rotated at random):
 * strong lead emoji, urgency or curiosity. */
export const SLIDESHOW_HOOKS: Record<string, Record<HookLanguage, string[]>> = {
  best_sellers: {
    fr: [
      "🔥 TOUT LE MONDE EN PARLE — t'as vu ça ?",
      "😱 Ces produits partent VITE",
      "👀 T'as pas encore vu nos best-sellers ?",
      "⚡ Les produits que tout le monde veut",
      "🚨 Alerte best-seller — stocks limités !",
    ],
    en: [
      "🔥 EVERYONE's talking about this — seen it?",
      "😱 These are flying off the shelves",
      "👀 Haven't seen our best-sellers yet?",
      "⚡ The products everyone wants",
      "🚨 Best-seller alert — limited stock!",
    ],
  },
  price_drops: {
    fr: [
      "💸 PRIX CASSÉS — avant qu'il soit trop tard",
      "🤑 Ces prix sont FOUS — profites-en maintenant",
      "📉 Chute de prix massive — stocks limités",
      "😤 Refuse de payer plein prix — regarde ça",
      "🔥 Soldes qui font MAL au portefeuille (en bien)",
    ],
    en: [
      "💸 PRICES SLASHED — before it's too late",
      "🤑 These prices are INSANE — grab them now",
      "📉 Massive price drop — limited stock",
      "😤 Refuse to pay full price — look at this",
      "🔥 Deals that HURT the wallet (in a good way)",
    ],
  },
  seasonal_ete: {
    fr: [
      "☀️ L'été québécois est COURT — profites-en !",
      "🌿 Ta terrasse mérite MIEUX que ça",
      "🏡 Transforme ton extérieur cet été",
      "🔥 Prêt pour les soupers sur la terrasse ?",
      "⚡ La saison patio commence MAINTENANT",
    ],
    en: [
      "☀️ Summer is SHORT — make the most of it!",
      "🌿 Your patio deserves BETTER",
      "🏡 Transform your outdoor space this summer",
      "🔥 Ready for dinners on the patio?",
      "⚡ Patio season starts NOW",
    ],
  },
  low_stock: {
    fr: [
      "⚠️ DERNIÈRE CHANCE — presque épuisé !",
      "🚨 Il en reste TRÈS PEU — dépêche-toi",
      "😱 Stock critique — commande avant ce soir",
      "⏰ Dans quelques heures ce sera trop tard",
      "🔴 RUPTURE IMMINENTE — dernières unités",
    ],
    en: [
      "⚠️ LAST CHANCE — almost sold out!",
      "🚨 Very FEW left — hurry",
      "😱 Critical stock — order before tonight",
      "⏰ In a few hours it'll be too late",
      "🔴 SELLING OUT — final units",
    ],
  },
  top3: {
    fr: [
      "🏆 TOP 3 — lequel tu veux en premier ?",
      "🎯 3 produits que tu DOIS voir aujourd'hui",
      "👑 Notre TOP 3 — le #1 va te surprendre",
      "🔥 3 coups de cœur — le dernier est 🤯",
      "⭐ TOP 3 du moment — vote pour ton préféré !",
    ],
    en: [
      "🏆 TOP 3 — which one first?",
      "🎯 3 products you MUST see today",
      "👑 Our TOP 3 — #1 will surprise you",
      "🔥 3 favorites — the last one is 🤯",
      "⭐ TOP 3 right now — vote for your favorite!",
    ],
  },
  kids_cars: {
    fr: [
      "🚗 TON ENFANT VA CAPOTER quand il verra ça",
      "😱 La réaction de nos kids — trop cute !",
      "🏎️ Vroom vroom — les kids ADORENT ça",
      "⚡ Le jouet dont TOUS les enfants rêvent",
      "🎮 Papa/Maman... JE VEUX ÇA !!!",
    ],
    en: [
      "🚗 Your kid will FREAK when they see this",
      "😱 Our kids' reaction — too cute!",
      "🏎️ Vroom vroom — kids LOVE these",
      "⚡ The toy EVERY kid dreams of",
      "🎮 Mom/Dad... I WANT THIS!!!",
    ],
  },
  kids_toys: {
    fr: [
      "🎁 Le cadeau parfait — garanti succès !",
      "😍 Ces jouets font des enfants HEUREUX",
      "🌟 Idée cadeau = ZÉRO stress avec ça",
      "🎉 Les jouets dont ils parlent ENCORE",
      "⭐ Cadeau parfait — approuvé par les kids !",
    ],
    en: [
      "🎁 The perfect gift — guaranteed hit!",
      "😍 These toys make kids HAPPY",
      "🌟 Gift idea = ZERO stress with this",
      "🎉 The toys they STILL talk about",
      "⭐ Perfect gift — kid-approved!",
    ],
  },
  wow_discovery: {
    fr: [
      "✨ Tu connaissais pas ça... et tu rates GROS",
      "😮 Ces produits cachés valent VRAIMENT le détour",
      "🔍 Nos trouvailles secrètes — maintenant révélées",
      "💡 Des produits méconnus mais INCROYABLES",
      "🤫 Le secret le mieux gardé de notre catalogue",
    ],
    en: [
      "✨ You didn't know this... and you're missing OUT",
      "😮 These hidden gems are REALLY worth it",
      "🔍 Our secret finds — now revealed",
      "💡 Little-known but INCREDIBLE products",
      "🤫 Our catalogue's best-kept secret",
    ],
  },
  office: {
    fr: [
      "💻 Ton bureau à la maison mérite MIEUX",
      "😤 Fini le bureau inconfortable — regarde ça",
      "🖥️ Transforme TON espace de travail maintenant",
      "⚡ Productivité MAX avec ces produits",
      "🏠 Télétravail = confort avec ces essentiels",
    ],
    en: [
      "💻 Your home office deserves BETTER",
      "😤 No more uncomfortable desk — look at this",
      "🖥️ Transform YOUR workspace now",
      "⚡ MAX productivity with these",
      "🏠 WFH = comfort with these essentials",
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
