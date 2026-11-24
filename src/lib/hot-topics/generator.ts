/**
 * Turn raw trend/headline candidates into ready-to-review "sujet chaud" posts.
 *
 * Two locks, in this order:
 *  1. Candidates whose title/context hit the deterministic blocklist (safety.ts) never reach the LLM.
 *  2. The LLM picks + writes; every proposal is then re-checked (category allow-list, blocklist on the
 *     card and caption, supplier names, length) — a model can be charmed by a catchy headline, the
 *     blocklist cannot.
 *
 * The model is the "strong" tier on purpose: choosing what is safe for a brand is a judging task, and
 * the 2026-10 tests showed the lite tier is far too lenient when judging.
 */
import { getAnthropicClient } from "@/lib/content-generator";
import { budgetedCreate } from "@/lib/llm-budget";
import { llmModel } from "@/lib/llm-models";
import { cleanSocialCaption } from "@/lib/strip-markdown";
import { ALLOWED_CATEGORIES, checkBrandSafety, type HotTopicCategory } from "./safety";
import type { TopicCandidate } from "./sources";

const CALL_TIMEOUT_MS = 60_000;
const MAX_CANDIDATES_TO_LLM = 40;

export interface HotTopicPost {
  candidate: TopicCandidate;
  category: HotTopicCategory;
  /** 1–5: how likely the question splits the room. */
  divisive: number;
  /** Card line 1, e.g. "Tu en penses quoi?" */
  lead: string;
  /** Card line 2: the question itself. */
  question: string;
  /** Facebook caption (ends with a question). */
  caption: string;
  /** One-line rationale, kept in the audit trail. */
  why: string;
}

export interface GenerateOutcome {
  posts: HotTopicPost[];
  /** Candidates dropped by the blocklist before the LLM saw them. */
  blockedBeforeLlm: number;
  /** Proposals the LLM returned that failed validation, with the reason. */
  rejected: Array<{ title: string; reason: string }>;
}

const SYSTEM_PROMPT = `Tu es le community manager de la page Facebook d'Ameublo Direct, une boutique québécoise de meubles. Ton travail: repérer, parmi les sujets chauds du jour, UN sujet léger qui fait réagir les gens, et écrire un post qui les fait commenter.

SUJETS PERMIS (category): "sport" (surtout le Canadien de Montréal, hockey, sports québécois), "meteo" (tempête, froid, premier gel, canicule), "culture" (télé, musique, humour, cinéma, personnalités publiques pour leur travail), "fetes" (Noël, Halloween, Vendredi fou, rentrée, etc.), "quotidien" (vie de tous les jours au Québec: déneigement, épicerie, trafic léger, habitudes).

INTERDIT, sans exception: politique et élus, religion, guerre, immigration, tragédies, décès, accidents, crimes, procès, santé, drames familiaux, faillites, rappels de produits, et tout sujet où une personne privée pourrait être visée. Si le sujet touche à l'un d'eux, ne le choisis pas.

RÈGLES D'ÉCRITURE:
- Tutoiement (tu/te/ton), ton québécois naturel, jamais de vouvoiement.
- Le post doit être une VRAIE question qui divise ou qui touche tout le monde (A ou B, trop/pas assez, d'accord/pas d'accord). Elle doit se comprendre sans lire un article.
- Critique permise: des décisions, des choix d'équipe, des performances. Jamais d'insulte ni d'attaque personnelle; parle des gestes, pas des personnes.
- N'affirme RIEN qui ne soit pas dans la manchette (ou son contexte) fournie: pas d'ambiance, pas de réaction de joueurs ou de partisans, pas de détail inventé. La légende reformule la manchette en une phrase factuelle, puis pose la question. N'invente aucun chiffre, score, montant ou citation.
- Ne parle PAS de meubles, de produits, de prix ni de la boutique. C'est un post de jasette.
- N'écris jamais "commente", "partage", "tague", "aime" ni "like": pas d'appât à engagement. La question seule suffit.
- "lead": court, max 28 caractères (ex: "Tu en penses quoi?", "Franchement,", "Question du jour:").
- "question": max 110 caractères, termine par un point d'interrogation.
- "caption": 1 à 3 phrases courtes, max 280 caractères, termine par la question. Maximum 1 emoji, aucun hashtag.

Réponds UNIQUEMENT par un tableau JSON (aucun texte autour), 1 à 3 éléments, du meilleur au moins bon:
[{"index": <numéro de la manchette>, "category": "sport|meteo|culture|fetes|quotidien", "brand_safe": true, "divisive": <1 à 5>, "lead": "...", "question": "...", "caption": "...", "why": "<une phrase>"}]
Si AUCUN sujet n'est sûr et léger, réponds [].`;

function buildUserPrompt(cands: TopicCandidate[], today: Date): string {
  const date = today.toLocaleDateString("fr-CA", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "America/Toronto" });
  const lines = cands.map((c, i) => {
    const ctx = c.context?.length ? ` — contexte: ${c.context.join(" | ")}` : "";
    const traffic = c.traffic ? ` [${c.traffic} recherches]` : "";
    return `${i + 1}. ${c.title}${traffic}${ctx}`;
  });
  return `Aujourd'hui: ${date}.\n\nSujets du moment (Québec):\n${lines.join("\n")}`;
}

/** Pull the JSON array out of a model reply that may be wrapped in prose or code fences. */
export function extractJsonArray(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const FORBIDDEN_WORDS = /\b(aosom|costway|homcom|outsunny|dropship)\b/i;
const ENGAGEMENT_BAIT = /\b(commente[zr]?|partage[zr]?|tague[zr]?|like[zr]?|abonne[zr]?-?vous)\b/i;

interface RawProposal {
  index?: unknown; category?: unknown; brand_safe?: unknown; divisive?: unknown;
  lead?: unknown; question?: unknown; caption?: unknown; why?: unknown;
}

/** Validate one model proposal against every hard rule. Returns the post, or the reason it failed. */
export function validateProposal(
  raw: RawProposal,
  candidates: TopicCandidate[],
): { post: HotTopicPost } | { reason: string; title: string } {
  const idx = typeof raw.index === "number" ? raw.index - 1 : NaN;
  const candidate = Number.isInteger(idx) ? candidates[idx] : undefined;
  const title = candidate?.title ?? `index ${String(raw.index)}`;
  if (!candidate) return { reason: "index inconnu", title };
  if (raw.brand_safe !== true) return { reason: "le modèle ne l'a pas jugé sûr", title };

  const category = String(raw.category ?? "") as HotTopicCategory;
  if (!ALLOWED_CATEGORIES.includes(category)) return { reason: `catégorie non permise (${String(raw.category)})`, title };

  const lead = typeof raw.lead === "string" ? raw.lead.trim() : "";
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  const caption = typeof raw.caption === "string" ? cleanSocialCaption(raw.caption).trim() : "";
  if (!question || !question.endsWith("?")) return { reason: "question absente ou sans point d'interrogation", title };
  if (question.length > 120) return { reason: "question trop longue pour la carte", title };
  if (lead.length > 32) return { reason: "accroche trop longue pour la carte", title };
  if (!caption || caption.length > 320) return { reason: "légende vide ou trop longue", title };
  // A trailing emoji / space after the question mark is fine ("…cette année? 🏒").
  if (!/\?[^\p{L}\p{N}?]{0,6}$/u.test(caption)) return { reason: "la légende ne finit pas par une question", title };
  if (/#\w/.test(caption)) return { reason: "hashtag dans la légende", title };

  const out = `${lead} ${question} ${caption}`;
  if (FORBIDDEN_WORDS.test(out)) return { reason: "nom de fournisseur interdit", title };
  if (ENGAGEMENT_BAIT.test(out)) return { reason: "appât à engagement", title };
  const verdict = checkBrandSafety(out);
  if (!verdict.safe) return { reason: `liste noire (${verdict.group}: ${verdict.match})`, title };

  const divisive = Math.min(5, Math.max(1, Math.round(Number(raw.divisive) || 1)));
  return {
    post: {
      candidate, category, divisive, lead, question, caption,
      why: typeof raw.why === "string" ? raw.why.trim().slice(0, 300) : "",
    },
  };
}

/** Pre-filter candidates with the blocklist so unsafe topics never reach the model. */
export function filterCandidates(all: TopicCandidate[]): { kept: TopicCandidate[]; blocked: number } {
  const kept: TopicCandidate[] = [];
  let blocked = 0;
  for (const c of all) {
    if (checkBrandSafety(c.title, ...(c.context ?? [])).safe) kept.push(c);
    else blocked++;
  }
  return { kept, blocked };
}

export async function generateHotTopicPosts(all: TopicCandidate[], now = new Date()): Promise<GenerateOutcome> {
  const { kept, blocked } = filterCandidates(all);
  const candidates = kept.slice(0, MAX_CANDIDATES_TO_LLM);
  if (candidates.length === 0) return { posts: [], blockedBeforeLlm: blocked, rejected: [] };

  const client = getAnthropicClient();
  const message = await budgetedCreate(
    client,
    {
      model: llmModel("strong"),
      max_tokens: 2500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(candidates, now) }],
    },
    { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
  );
  const text = message.content[0]?.type === "text" ? message.content[0].text : "";

  const posts: HotTopicPost[] = [];
  const rejected: Array<{ title: string; reason: string }> = [];
  for (const raw of extractJsonArray(text)) {
    if (!raw || typeof raw !== "object") continue;
    const res = validateProposal(raw as RawProposal, candidates);
    if ("post" in res) posts.push(res.post);
    else rejected.push({ title: res.title, reason: res.reason });
  }
  posts.sort((a, b) => b.divisive - a.divisive);
  return { posts, blockedBeforeLlm: blocked, rejected };
}
