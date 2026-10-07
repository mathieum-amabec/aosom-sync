/**
 * Captions for "La semaine Ameublo". The model writes ONLY the hook and the lines around the
 * facts; code writes every number a customer relies on (price, rabais, link, shipping) from the
 * live product data, then validates the text deterministically and has it re-read by a judge.
 * A caption that fails twice is not posted: the runner skips the slot and says why.
 */
import { getAnthropicClient } from "@/lib/content-generator";
import { llmModel } from "@/lib/llm-models";
import { budgetedCreate } from "@/lib/llm-budget";
import { cleanSocialCaption } from "@/lib/strip-markdown";
import { stripSupplierBrands, forbiddenBrandsIn, detectDescriptionLanguage } from "@/lib/catalog-guard";
import type { BuiltCaptions, FormatId, LiveProduct, PlannedPost } from "./types";

export type TextGen = (prompt: string) => Promise<string>;

const CALL_TIMEOUT_MS = 40_000;
export const SHOP = { fr: "https://ameublodirect.ca", en: "https://furnishdirect.ca" } as const;

export const defaultTextGen: TextGen = async (prompt) => {
  const message = await budgetedCreate(
    getAnthropicClient(),
    { model: llmModel("lite"), max_tokens: 500, messages: [{ role: "user", content: prompt }] },
    { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
  );
  return message.content[0]?.type === "text" ? message.content[0].text : "";
};

type Lang = "fr" | "en";

// ── Facts (code-owned) ─────────────────────────────────────────────────────

export function formatPrice(n: number, lang: Lang): string {
  return lang === "fr" ? `${n.toFixed(2).replace(".", ",")} $` : `$${n.toFixed(2)}`;
}

const title = (p: LiveProduct, lang: Lang) => (lang === "fr" ? p.titleFr : p.titleEn);
const url = (p: LiveProduct, lang: Lang) => `${SHOP[lang]}/products/${p.handle}`;

function priceText(p: LiveProduct, lang: Lang): string {
  if (!p.compareAt) return formatPrice(p.price, lang);
  const pct = Math.round((1 - p.price / p.compareAt) * 100);
  return lang === "fr"
    ? `${formatPrice(p.price, lang)} (avant ${formatPrice(p.compareAt, lang)}, -${pct} %)`
    : `${formatPrice(p.price, lang)} (was ${formatPrice(p.compareAt, lang)}, ${pct}% off)`;
}

export function factsBlock(plan: PlannedPost, lang: Lang): string {
  const ps = plan.products;
  if (ps.length === 1) {
    const p = ps[0];
    return `${title(p, lang)} — ${priceText(p, lang)}\n${lang === "fr" ? "Voir le produit" : "See the product"}: ${url(p, lang)}`;
  }
  return ps
    .map((p, i) => {
      const mark = plan.format === "ab" ? `${i === 0 ? "A" : "B"} — ` : "• ";
      return `${mark}${title(p, lang)} — ${priceText(p, lang)}\n${url(p, lang)}`;
    })
    .join("\n");
}

const HASHTAGS: Record<Lang, Record<FormatId, string>> = {
  fr: {
    nouveautes: "#nouveautés", baisses: "#rabais", piece: "#décoration", ab: "#tuchoisislequel",
    "top-ventes": "#populaire", astuce: "#astucedéco", coeur: "#coupdecoeur", vedette: "#meubles",
  },
  en: {
    nouveautes: "#newarrivals", baisses: "#sale", piece: "#homedecor", ab: "#thisorthat",
    "top-ventes": "#bestsellers", astuce: "#decortips", coeur: "#favourite", vedette: "#furniture",
  },
};

export function footer(plan: PlannedPost, lang: Lang): string {
  const base = lang === "fr" ? "#ameublodirect #maison #québec" : "#furnishdirect #home #canada";
  return `${lang === "fr" ? "Livraison gratuite." : "Free shipping."}\n${HASHTAGS[lang][plan.format]} ${base}`;
}

export function assemble(plan: PlannedPost, lang: Lang, body: string): string {
  return `${body.trim()}\n\n${factsBlock(plan, lang)}\n\n${footer(plan, lang)}`;
}

// ── Prompt ─────────────────────────────────────────────────────────────────

function angle(plan: PlannedPost, lang: Lang): string {
  const n = plan.products.length;
  const t = plan.topic?.[lang] ?? "";
  const fr: Record<FormatId, string> = {
    nouveautes: `Annonce ${n} nouveautés arrivées cette semaine.`,
    baisses: `Annonce des prix en baisse sur ${n} produits (les montants sont affichés automatiquement plus bas).`,
    piece: `Présente ${t}: ${n} pièces qui se marient pour composer la pièce. Pose une question sur le style.`,
    ab: "Deux produits, A puis B. Demande lequel les gens choisiraient et invite à répondre A ou B en commentaire.",
    "top-ventes": `Présente les ${n} produits les plus populaires cette semaine.`,
    astuce: `Donne cette astuce déco (tu peux la reformuler, sans changer un seul chiffre): «${t}» Puis présente le produit comme une bonne option.`,
    coeur: "Écris un texte émotionnel autour d'un seul produit: l'ambiance, le moment qu'il crée. Aucune promesse technique.",
    vedette: "Présente ce produit en 2 ou 3 phrases.",
  };
  const en: Record<FormatId, string> = {
    nouveautes: `Announce ${n} new arrivals this week.`,
    baisses: `Announce price drops on ${n} products (the amounts are added automatically below).`,
    piece: `Present ${t}: ${n} pieces that go together to make the room. Ask a question about style.`,
    ab: "Two products, A then B. Ask which one people would pick and invite them to answer A or B in the comments.",
    "top-ventes": `Present the ${n} most popular products this week.`,
    astuce: `Share this decor tip (you may rephrase it, without changing a single number): "${t}" Then present the product as a good option.`,
    coeur: "Write an emotional caption around a single product: the mood, the moment it creates. No technical promises.",
    vedette: "Present this product in 2 or 3 sentences.",
  };
  return (lang === "fr" ? fr : en)[plan.format];
}

export function bodyPrompt(plan: PlannedPost, lang: Lang, feedback?: string): string {
  const names = plan.products.map((p, i) => `${plan.format === "ab" ? (i === 0 ? "A" : "B") : "-"} ${title(p, lang)}`).join("\n");
  const fix = feedback ? `\n${lang === "fr" ? "CORRIGE ce défaut de ta version précédente" : "FIX this flaw from your previous version"}: ${feedback}\n` : "";
  const multi = plan.products.length > 1;
  const listRuleFr = multi ? "\n- Ne liste PAS les produits un par un: ils sont listés automatiquement sous ton texte. Parle de ce qui les réunit, de l'ambiance, du besoin." : "";
  const listRuleEn = multi ? "\n- Do NOT list the products one by one: they are listed automatically under your text. Talk about what brings them together, the mood, the need." : "";
  const popular = plan.format === "top-ventes";
  const popFr = popular ? "" : "\n- N'emploie pas « favoris », « populaires » ni « meilleurs vendeurs »: ce n'est pas un fait connu ici.";
  const popEn = popular ? "" : "\n- Do not call the products \"favourites\", \"popular\" or \"best sellers\": that is not a known fact here.";
  if (lang === "fr") {
    return `Tu écris le texte d'une publication Facebook et Instagram pour Ameublo Direct, une boutique québécoise de meubles (livraison gratuite).
Format du jour: ${plan.label}. ${angle(plan, lang)}

Produits (ce sont les SEULS faits que tu connais):
${names}
${fix}
Règles strictes:
- Tutoiement. Ton chaleureux, naturel, québécois sans joual. 2 à 4 courtes phrases, 1 ou 2 émojis au maximum.
- Commence par une accroche qui arrête le défilement (une question ou une affirmation surprenante), pas un "Découvrez" générique.
- N'écris AUCUN prix, AUCUN pourcentage, AUCUN lien et AUCUN mot-clic: ils sont ajoutés automatiquement.
- N'invente rien: ni matériau, ni dimension, ni garantie, ni avis de client, ni quantité qui ne figure pas dans les noms ci-dessus.
- Aucune fausse urgence ("dernières unités", "aujourd'hui seulement").
- Ne parle PAS de livraison ni d'expédition (c'est ajouté automatiquement), ni de régions ou de pays.${listRuleFr}${popFr}
- Écris UNIQUEMENT en français, même si un nom de produit est dans une autre langue.
- Aucun nom de marque de fournisseur. Seulement "Ameublo Direct" si tu dois te nommer.
- Termine par une courte question qui invite à commenter.
- Écris uniquement le texte de la publication, sans étiquette ni guillemets.`;
  }
  return `You write the caption of a Facebook and Instagram post for Furnish Direct, a Canadian furniture store (free shipping).
Today's format: ${plan.label}. ${angle(plan, lang)}

Products (these are the ONLY facts you know):
${names}
${fix}
Strict rules:
- Warm, natural, friendly tone. 2 to 4 short sentences, 1 or 2 emojis at most.
- Open with a scroll-stopping hook (a question or a surprising statement), not a generic "Discover".
- Write NO price, NO percentage, NO link and NO hashtag: they are added automatically.
- Invent nothing: no material, dimension, warranty, customer review or quantity that is not in the names above.
- No fake urgency ("last units", "today only").
- Do NOT mention delivery, shipping, regions or countries (that is added automatically).${listRuleEn}${popEn}
- Write ONLY in English, even if a product name is in another language: translate it naturally.
- No supplier brand name. Only "Furnish Direct" if you must name yourself.
- End with a short question that invites comments.
- Write only the post text, with no label or quotation marks.`;
}

// ── Deterministic validation ───────────────────────────────────────────────

const URGENCY = /derni[eè]res? unit|derniers? articles|stock limit|seulement aujourd|aujourd'hui seulement|last (few )?units|limited stock|today only|hurry|act fast|d[ée]p[êe]che/i;
const DELIVERY = /livraison|livr[ée]|exp[ée]di|deliver|shipping|ship(s|ped)? |your door|ta porte|votre porte|doorstep|partout au|across canada|anywhere in|right here in/i;
const NUM = /\d+(?:[.,]\d+)?/g;

export interface Verdict {
  ok: boolean;
  issue?: string;
}

export function validateBody(body: string, plan: PlannedPost, lang: Lang): Verdict {
  const t = body.trim();
  if (t.length < 40) return { ok: false, issue: "trop court" };
  if (t.length > 700) return { ok: false, issue: "trop long (700 caractères maximum)" };
  if (/[$€£]|%|https?:|www\.|#/.test(t)) return { ok: false, issue: "contient un prix, un pourcentage, un lien ou un mot-clic" };
  if (/aosom/i.test(t) || forbiddenBrandsIn(t).length > 0) return { ok: false, issue: "contient un nom de fournisseur" };
  if (URGENCY.test(t)) return { ok: false, issue: "fausse urgence" };
  if (DELIVERY.test(t)) return { ok: false, issue: "parle de livraison (ajoutée automatiquement)" };
  if (!t.includes("?")) return { ok: false, issue: "ne se termine pas par une question" };
  if (plan.format === "ab" && !(/\bA\b/.test(t) && /\bB\b/.test(t))) return { ok: false, issue: "doit demander de répondre A ou B" };

  // Numbers: only the ones present in the facts the model was given (names, rule, count).
  const allowed = new Set<string>([String(plan.products.length)]);
  const source = `${plan.products.map((p) => title(p, lang)).join(" ")} ${plan.topic?.[lang] ?? ""}`;
  for (const m of source.match(NUM) ?? []) allowed.add(m);
  for (const m of t.match(NUM) ?? []) if (!allowed.has(m)) return { ok: false, issue: `chiffre inventé: ${m}` };

  if (t.length > 80) {
    const l = detectDescriptionLanguage(t);
    if (lang === "fr" && l.lang === "EN") return { ok: false, issue: "écrit en anglais" };
    if (lang === "en" && l.lang === "FR") return { ok: false, issue: "written in French" };
  }
  return { ok: true };
}

// ── Judge ──────────────────────────────────────────────────────────────────

function judgePrompt(plan: PlannedPost, lang: Lang, body: string): string {
  const facts = plan.products.map((p) => `- ${title(p, lang)}`).join("\n");
  return `You are a strict fact-checker for a furniture store's social posts. Facts available (the ONLY allowed ones):
${facts}${plan.topic ? `\nTopic/tip: ${plan.topic[lang]}` : ""}
- The store's own name (Ameublo Direct / Furnish Direct) may be used. Delivery is NOT a topic of the post.

Post text:
"""${body}"""

Does the post state ANY claim not supported by those facts (material, size, feature, warranty, quantity, discount, review, availability, urgency, comparison to competitors)? Mood and style words are fine. Answer with JSON only: {"ok": true} or {"ok": false, "issue": "<short reason>"}.`;
}

export async function judgeBody(plan: PlannedPost, lang: Lang, body: string, gen: TextGen): Promise<Verdict> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await gen(judgePrompt(plan, lang, body));
    const m = raw.match(/\{[\s\S]*?\}/);
    if (!m) continue;
    try {
      const j = JSON.parse(m[0]) as { ok?: unknown; issue?: unknown };
      if (typeof j.ok === "boolean") return j.ok ? { ok: true } : { ok: false, issue: String(j.issue ?? "affirmation non fondée") };
    } catch {
      /* retry */
    }
  }
  return { ok: false, issue: "le réviseur n'a pas donné de verdict lisible" };
}

// ── Orchestration ──────────────────────────────────────────────────────────

async function oneLanguage(plan: PlannedPost, lang: Lang, gen: TextGen): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  let feedback: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await gen(bodyPrompt(plan, lang, feedback));
    const body = stripSupplierBrands(cleanSocialCaption(raw)).replace(/^["«»“”]+|["«»“”]+$/g, "").trim();
    const v = validateBody(body, plan, lang);
    if (!v.ok) {
      feedback = v.issue;
      console.log(`[semaine] ${plan.format} ${lang} rejeté (validation: ${v.issue}) « ${body.slice(0, 160).replace(/\s+/g, " ")} »`);
      continue;
    }
    const j = await judgeBody(plan, lang, body, gen);
    if (!j.ok) {
      feedback = j.issue;
      console.log(`[semaine] ${plan.format} ${lang} rejeté (réviseur: ${j.issue}) « ${body.slice(0, 160).replace(/\s+/g, " ")} »`);
      continue;
    }
    return { ok: true, text: assemble(plan, lang, body) };
  }
  return { ok: false, reason: `${lang.toUpperCase()}: ${feedback ?? "rejeté"}` };
}

export async function buildCaptions(plan: PlannedPost, gen: TextGen = defaultTextGen): Promise<{ ok: true; captions: BuiltCaptions } | { ok: false; reason: string }> {
  const [fr, en] = await Promise.all([oneLanguage(plan, "fr", gen), oneLanguage(plan, "en", gen)]);
  if (!fr.ok) return { ok: false, reason: fr.reason };
  if (!en.ok) return { ok: false, reason: en.reason };
  return { ok: true, captions: { fr: fr.text, en: en.text } };
}
