/**
 * Deterministic captions for the Studio Ameublo Reels (FR = Ameublo Direct, EN = Furnish Direct).
 *
 * No LLM: the caption is stored on the video, shown (and editable) in /ameublo, and published
 * as-is (queue metadata `keepCaption`). Honest copy only: a price, free shipping, a link.
 */
import type { Lang } from "@/lib/ameublo-i18n";
import { priceFmt } from "@/lib/ameublo-i18n";

export type AmeubloStyle = "reaction" | "vitrine" | "astuce" | "devine" | "ab" | "top3" | "piece";

export const STYLE_LABEL: Record<AmeubloStyle, { fr: string; en: string }> = {
  reaction: { fr: "Réaction", en: "Reaction" },
  vitrine: { fr: "Vitrine", en: "Showcase" },
  astuce: { fr: "Astuce d’Ameublo", en: "Furni’s tip" },
  devine: { fr: "Devine le prix", en: "Guess the price" },
  ab: { fr: "Tu prends lequel ?", en: "Which one?" },
  top3: { fr: "Top 3", en: "Top 3" },
  piece: { fr: "La pièce en 4 articles", en: "The room in 4 pieces" },
};

export const SHOP_URL: Record<Lang, string> = {
  fr: "https://ameublodirect.ca",
  en: "https://furnishdirect.ca",
};

export function productUrl(handle: string | null | undefined, lang: Lang): string {
  return handle ? `${SHOP_URL[lang]}/products/${handle}` : SHOP_URL[lang];
}

export interface CaptionInput {
  style: AmeubloStyle;
  lang: Lang;
  /** Display titles, in video order (already FR / EN). */
  titles: string[];
  prices: number[];
  /** Shopify handles, in video order. */
  handles: (string | null | undefined)[];
  room?: string;
  /** Top 3 price ceiling. */
  cap?: number;
  /** Rotates the wording so a series doesn't read identically. */
  variant?: number;
}

const pick = <T,>(arr: readonly T[], v: number): T => arr[Math.abs(v) % arr.length];

const TAGS = {
  fr: "#ameublodirect #décoration #maison #québec",
  en: "#furnishdirect #homedecor #furniture #canada",
};

export function ameubloCaption(i: CaptionInput): string {
  const v = i.variant ?? 0;
  const { lang } = i;
  const t0 = i.titles[0] ?? "";
  const p0 = i.prices[0];
  const url = productUrl(i.handles[0], lang);
  const ship = lang === "fr" ? "Livraison gratuite partout au Canada." : "Free shipping across Canada.";
  const lines: string[] = [];

  switch (i.style) {
    case "reaction":
      lines.push(
        lang === "fr"
          ? pick(["Ils l’ont adoré. Et toi ?", "Regarde leur réaction.", "Le genre de meuble qui fait dire « wow »."], v)
          : pick(["They loved it. Will you?", "Look at that reaction.", "The kind of piece that makes you say “wow”."], v),
        `${t0} — ${priceFmt(p0, lang)}`,
        ship,
        url,
      );
      break;
    case "vitrine":
      lines.push(
        lang === "fr"
          ? pick(["Une belle trouvaille pour ta maison.", "Du style sans te ruiner.", "Elle va bien dans ton salon, non ?"], v)
          : pick(["A great find for your home.", "Style without the splurge.", "Looks good in your living room, right?"], v),
        `${t0} — ${priceFmt(p0, lang)}`,
        ship,
        url,
      );
      break;
    case "astuce":
      lines.push(
        lang === "fr" ? "Une astuce d’Ameublo avant d’acheter." : "A tip from Furni before you buy.",
        `${t0} — ${priceFmt(p0, lang)}`,
        ship,
        url,
      );
      break;
    case "devine":
      lines.push(
        lang === "fr" ? "Devine le prix. Réponse dans la vidéo !" : "Guess the price. The answer is in the video!",
        lang === "fr" ? `${t0}` : `${t0}`,
        lang === "fr" ? `Écris ton prix en commentaire. ${ship}` : `Drop your guess in the comments. ${ship}`,
        url,
      );
      break;
    case "ab":
      lines.push(
        lang === "fr" ? "Tu prends lequel ? A ou B ?" : "Which one would you take? A or B?",
        ...i.titles.slice(0, 2).map((t, k) => `${k === 0 ? "A" : "B"}${lang === "fr" ? " :" : ":"} ${t} — ${priceFmt(i.prices[k], lang)}`),
        ship,
        SHOP_URL[lang],
      );
      break;
    case "top3": {
      lines.push(
        lang === "fr" ? `3 trouvailles sous ${i.cap ?? ""} $. Ton préféré ?` : `3 finds under $${i.cap ?? ""}. Your favourite?`,
        ...i.titles.slice(0, 3).map((t, k) => `${k + 1}. ${t} — ${priceFmt(i.prices[k], lang)}`),
        ship,
        SHOP_URL[lang],
      );
      break;
    }
    case "piece": {
      const total = i.prices.reduce((a, b) => a + b, 0);
      lines.push(
        lang === "fr"
          ? `Ta pièce complète en 4 articles${i.room ? ` (${i.room})` : ""} : ${priceFmt(total, lang)} au total.`
          : `Your complete room in 4 pieces${i.room ? ` (${i.room})` : ""}: ${priceFmt(total, lang)} total.`,
        ...i.titles.slice(0, 4).map((t, k) => `• ${t} — ${priceFmt(i.prices[k], lang)}`),
        ship,
        SHOP_URL[lang],
      );
      break;
    }
  }
  lines.push(TAGS[lang]);
  return lines.join("\n");
}
