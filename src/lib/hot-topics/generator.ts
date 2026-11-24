/**
 * Turn raw headline / fact candidates into ready-to-review "sujet chaud" posts.
 *
 * Locks, in this order:
 *  1. Stale or undated candidates, and candidates whose title/context hit the HARD blocklist
 *     (safety.ts), never reach the LLM.
 *  2. The LLM picks + writes — and must NAME its subject. Every proposal is then re-checked in code:
 *     the subject must be in the source and on the card, every number and every proper noun must
 *     come from the source (a model can be charmed by a headline, or invent a detail; the code
 *     cannot), then the category allow-list, the blocklist (hard AND soft) on the card and caption,
 *     supplier names, engagement-bait and length.
 *
 * The model is the "strong" tier on purpose: choosing what is safe for a brand is a judging task, and
 * the 2026-10 tests showed the lite tier is far too lenient when judging.
 */
import { getAnthropicClient } from "@/lib/content-generator";
import { budgetedCreate } from "@/lib/llm-budget";
import { llmModel } from "@/lib/llm-models";
import { cleanSocialCaption } from "@/lib/strip-markdown";
import { ALLOWED_CATEGORIES, checkBrandSafety, normalizeForSafety, softHits, type HotTopicCategory } from "./safety";
import type { TopicCandidate } from "./sources";

const CALL_TIMEOUT_MS = 60_000;
const MAX_CANDIDATES_TO_LLM = 40;
/** Candidates older than this never reach the model. */
export const MAX_CANDIDATE_AGE_H = 36;
/** A news post must be published (or refused) within this many hours of its source. */
export const NEWS_POST_LIFETIME_H = 48;

export interface HotTopicPost {
  kind: "news" | "calendar";
  /** De-duplication key: the headline for news, `calendrier:<id>` for the calendar bank. */
  topicKey: string;
  /** Feed id, or "calendrier". */
  source: string;
  /** Headline / fact the post is built on (shown to the approver). */
  sourceTitle: string;
  sourceUrl?: string;
  /** Publication time of the source, unix seconds. */
  sourcePublished?: number;
  /** The named subject of the post (news only). */
  subject?: string;
  category: HotTopicCategory;
  /** 1–5: how likely the question splits the room. */
  divisive: number;
  /** Card block 1: a plain factual sentence that names the subject. */
  factLine: string;
  /** Card block 2: the question itself. */
  question: string;
  /** Facebook caption (ends with a question). */
  caption: string;
  /** One-line rationale, kept in the audit trail. */
  why: string;
  /** Sensitive ("à vérifier") words found in the source — shown to the approver. */
  flags: string[];
  /** Matches a current Google Trends search. */
  trending: boolean;
  /** Number of other headlines covering the same name (cross-source signal). */
  buzz?: number;
  /** Unix seconds after which the post must not be published. */
  expiresAt: number;
}

export interface GenerateOutcome {
  posts: HotTopicPost[];
  /** Candidates dropped before the LLM saw them (stale, undated, blocklisted). */
  blockedBeforeLlm: number;
  /** Proposals the LLM returned that failed validation, with the reason. */
  rejected: Array<{ title: string; reason: string }>;
  /** The model's raw reply (first 6000 chars) — for the preview script; not persisted. */
  rawReply?: string;
}

const SYSTEM_PROMPT = `Tu es le community manager de la page Facebook d'Ameublo Direct, une boutique québécoise de meubles. Ton travail: repérer, parmi les nouvelles du jour, des sujets légers que les Québécois connaissent déjà, et écrire des posts qui les font réagir et commenter. Un sujet repris par plusieurs manchettes (marqué [repris dans N manchettes]) est celui dont tout le monde parle: privilégie-le.

PRINCIPE N°1: LES GENS DOIVENT SAVOIR DE QUOI ON PARLE. Le post nomme toujours le sujet, tel qu'écrit dans la manchette (équipe, événement, émission, personne). Jamais de formule floue comme «Gros coup du CH!», «Quelle décision!» ou «Il a tout changé». Quelqu'un qui n'a lu aucun article doit comprendre le sujet en lisant la carte.

SUJETS PERMIS (category): "sport" (surtout le Canadien de Montréal et le hockey), "meteo" (tempête, froid, première neige), "culture" (télé, musique, humour, cinéma: le travail des personnalités publiques seulement), "fetes", "quotidien" (vie de tous les jours au Québec), "maison" (chauffage, déneigement, décoration, vie à la maison en hiver).

INTERDIT, sans exception: politique et élus, religion, guerre, immigration, tragédies, décès, accidents, crimes, procès, santé, blessures, drames familiaux, faillites, rappels de produits, rumeurs, vie privée, et tout sujet où une personne privée pourrait être visée. Si le sujet touche à l'un d'eux, ne le choisis pas.

NOMS DE PERSONNES: une équipe, un événement ou une émission se nomme librement. Une personne (joueur, entraîneur, artiste) ne se nomme que pour une DÉCISION (échange, contrat, alignement, choix de l'équipe) ou une PERFORMANCE de jeu ou de spectacle tirée de la manchette. Jamais pour sa santé, sa vie privée, un comportement ou une rumeur. Une transaction ou une acquisition du Canadien est une décision de l'équipe: c'est un excellent sujet (ex.: «Le Canadien a-t-il trop payé pour X?», bon coup ou pari risqué).

CHAQUE POST A DEUX BLOCS:
- "subject": le nom propre ou le groupe de mots COPIÉ MOT POUR MOT de la manchette (1 à 4 mots: «Dylan Larkin», «Kings de Los Angeles»). Jamais une paraphrase.
- "fact_line": UNE phrase factuelle (max 105 caractères) qui contient le sujet nommé et le fait, reformulés depuis la manchette. Exemple: «Le Canadien a perdu 4-3 contre les Flyers de Philadelphie samedi soir.»
- "question": la question (max 110 caractères, se termine par «?»). Préfère un choix A ou B, ou trop/pas assez.

RÈGLES D'ÉCRITURE:
- Tutoiement (tu/te/ton), ton québécois naturel, jamais de vouvoiement.
- Critique permise: des décisions, des choix d'équipe, des performances. Jamais d'insulte ni d'attaque personnelle; parle des gestes, pas des personnes.
- N'affirme RIEN qui ne soit pas dans la manchette ou son contexte: pas d'ambiance, pas de réaction de joueurs ou de partisans, pas de détail inventé. Tout chiffre, score, montant ou nom propre doit venir mot pour mot de la manchette ou du contexte.
- Ne parle PAS de meubles, de produits, de prix ni de la boutique. C'est un post de jasette.
- N'écris jamais «commente», «partage», «tague», «identifie», «en commentaires», «like» ni rien qui demande une action: la question seule suffit.
- "caption": 1 à 3 phrases courtes, max 280 caractères, redit le fait puis termine par la question. Maximum 1 emoji, aucun hashtag.
- Les manchettes marquées [sensible] contiennent un sujet délicat: évite cet angle et choisis plutôt un autre sujet si tu ne peux pas poser une question sur autre chose que ce volet.

Réponds UNIQUEMENT par un tableau JSON (aucun texte autour), 3 éléments sur 3 sujets DIFFÉRENTS si possible, du meilleur au moins bon:
[{"index": <numéro de la manchette>, "category": "sport|meteo|culture|fetes|quotidien|maison", "brand_safe": true, "divisive": <1 à 5>, "subject": "<copié mot pour mot de la manchette>", "fact_line": "...", "question": "...", "caption": "...", "why": "<une phrase>"}]
Si AUCUN sujet n'est sûr, connu et léger, réponds [].`;

function ageLabel(c: TopicCandidate, nowSec: number): string {
  if (c.published === undefined) return "";
  const h = Math.max(0, Math.round((nowSec - c.published) / 3600));
  return h < 1 ? " [à l'instant]" : ` [il y a ${h} h]`;
}

function buildUserPrompt(cands: TopicCandidate[], today: Date): string {
  const date = today.toLocaleDateString("fr-CA", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "America/Toronto" });
  const nowSec = Math.floor(today.getTime() / 1000);
  const lines = cands.map((c, i) => {
    const ctx = c.context?.length ? ` — contexte: ${c.context.join(" | ")}` : "";
    const tags = [
      c.kind === "fact" ? " [FAIT officiel]" : "",
      c.trending ? " [tendance Google]" : "",
      c.buzz ? ` [repris dans ${c.buzz + 1} manchettes]` : "",
      softHits(c.title, ...(c.context ?? [])).length ? " [sensible]" : "",
    ].join("");
    return `${i + 1}. ${c.title}${ageLabel(c, nowSec)}${tags}${ctx}`;
  });
  return `Aujourd'hui: ${date}.\n\nNouvelles du moment (Québec), plus récentes d'abord:\n${lines.join("\n")}`;
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

const FORBIDDEN_WORDS = /\b(aosom|costway|homcom|outsunny|pawhut|vinsetto|durhand|kleankin|soozier|giantex|dropship)\b/i;
/** Runs on accent-stripped text. */
const ENGAGEMENT_BAIT = /\b(commente\w*|partage\w*|tague\w*|identifie\w*|mentionne\w*|likes?|like[zr]|reagis\w*|abonne\w*|clique\w*|vote[zr]|dis nous en|en commentaires?|dans les commentaires?|ecris nous|envoie\w* (?:ca|ce)\w*)\b/;

/** Words that may appear capitalised mid-sentence without being in the source. */
const PROPER_NOUN_ALLOWLIST = new Set([
  "canadien", "canadiens", "ch", "quebec", "montreal", "quebecois", "quebecoise", "facebook", "noel",
  "halloween", "boxing", "day", "lnh", "nhl", "centre", "bell", "canada", "ameublo", "direct",
]);

function wordsOf(norm: string): string[] {
  return norm.split(" ").filter(Boolean);
}

function includesPhrase(haystackNorm: string, needleNorm: string): boolean {
  return needleNorm.length > 0 && ` ${haystackNorm} `.includes(` ${needleNorm} `);
}

/** Numbers (digits, with , or . decimals) found in a text, normalised. */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));
}

/** Capitalised words that are not at the start of a sentence — candidate proper nouns. */
export function midSentenceProperNouns(text: string): string[] {
  const out: string[] = [];
  const re = /(?<=[\p{Ll}\d,;:'’-] )[\p{Lu}][\p{L}'’-]{2,}/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

/** Checks shared by every post, LLM-written or from the calendar bank. Returns a reason, or null. */
export function checkPostText(p: { factLine: string; question: string; caption: string }): string | null {
  const { factLine, question, caption } = p;
  if (!factLine || factLine.length > 110) return "phrase factuelle absente ou trop longue pour la carte";
  if (factLine.includes("?")) return "la phrase factuelle contient un point d'interrogation";
  if (!question || !question.endsWith("?")) return "question absente ou sans point d'interrogation";
  if (question.length > 120) return "question trop longue pour la carte";
  if (!caption || caption.length > 320) return "légende vide ou trop longue";
  // A trailing emoji / space after the question mark is fine ("…cette année? 🏒").
  if (!/\?[^\p{L}\p{N}?]{0,6}$/u.test(caption)) return "la légende ne finit pas par une question";
  if (/#\w/.test(caption)) return "hashtag dans la légende";
  if ((caption.match(/\p{Extended_Pictographic}/gu) ?? []).length > 1) return "plus d'un emoji dans la légende";

  const out = `${factLine} ${question} ${caption}`;
  if (FORBIDDEN_WORDS.test(out)) return "nom de fournisseur interdit";
  if (ENGAGEMENT_BAIT.test(normalizeForSafety(out))) return "appât à engagement";
  const verdict = checkBrandSafety(out);
  if (!verdict.safe) return `liste noire (${verdict.group}: ${verdict.match})`;
  if (verdict.soft?.length) return `mot sensible dans le post (${verdict.soft.join(", ")})`;
  return null;
}

interface RawProposal {
  index?: unknown; category?: unknown; brand_safe?: unknown; divisive?: unknown; subject?: unknown;
  fact_line?: unknown; question?: unknown; caption?: unknown; why?: unknown;
}

function sourceText(c: TopicCandidate): string {
  return [c.title, ...(c.context ?? [])].join(" ");
}

/** Validate one model proposal against every hard rule. Returns the post, or the reason it failed. */
export function validateProposal(
  raw: RawProposal,
  candidates: TopicCandidate[],
  now: Date = new Date(),
): { post: HotTopicPost } | { reason: string; title: string } {
  const idx = typeof raw.index === "number" ? raw.index - 1 : NaN;
  const candidate = Number.isInteger(idx) ? candidates[idx] : undefined;
  const title = candidate?.title ?? `index ${String(raw.index)}`;
  if (!candidate) return { reason: "index inconnu", title };
  if (raw.brand_safe !== true) return { reason: "le modèle ne l'a pas jugé sûr", title };

  const category = String(raw.category ?? "") as HotTopicCategory;
  if (!ALLOWED_CATEGORIES.includes(category)) return { reason: `catégorie non permise (${String(raw.category)})`, title };

  // A hard fact (NHL score) is stated by the code, not paraphrased by the model: it cannot swap a score.
  const factLine = candidate.kind === "fact"
    ? `${candidate.title}.`
    : typeof raw.fact_line === "string" ? raw.fact_line.trim() : "";
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  const caption = typeof raw.caption === "string" ? cleanSocialCaption(raw.caption).trim() : "";
  // For a hard fact (a Canadiens score) the subject is the team — stated by the code, not the model.
  const subject = candidate.kind === "fact" ? "Canadien" : typeof raw.subject === "string" ? raw.subject.trim() : "";

  const textReason = checkPostText({ factLine, question, caption });
  if (textReason) return { reason: textReason, title };

  // The named subject: in the source, on the card.
  const srcNorm = normalizeForSafety(sourceText(candidate));
  const subjectNorm = normalizeForSafety(subject);
  if (subjectNorm.length < 3 || subject.length > 60) return { reason: "sujet nommé absent", title };
  if (!includesPhrase(srcNorm, subjectNorm)) return { reason: `sujet absent de la source (${subject})`, title };
  if (!includesPhrase(normalizeForSafety(factLine), subjectNorm)) return { reason: "le sujet n'est pas nommé sur la carte", title };

  // Nothing invented: every number and every mid-sentence proper noun must be in the source.
  const srcNumbers = new Set(numbersIn(sourceText(candidate)));
  for (const n of numbersIn(`${factLine} ${question} ${caption}`)) {
    if (!srcNumbers.has(n)) return { reason: `chiffre absent de la source (${n})`, title };
  }
  const srcWords = new Set(wordsOf(srcNorm));
  for (const noun of midSentenceProperNouns(`${factLine} ${question} ${caption}`)) {
    const n = normalizeForSafety(noun);
    if (!srcWords.has(n) && !PROPER_NOUN_ALLOWLIST.has(n)) return { reason: `nom propre absent de la source (${noun})`, title };
  }

  const nowSec = Math.floor(now.getTime() / 1000);
  const published = candidate.published ?? nowSec;
  const divisive = Math.min(5, Math.max(1, Math.round(Number(raw.divisive) || 1)));
  return {
    post: {
      kind: "news",
      topicKey: candidate.title,
      source: candidate.source,
      sourceTitle: candidate.title,
      ...(candidate.url ? { sourceUrl: candidate.url } : {}),
      ...(candidate.published !== undefined ? { sourcePublished: candidate.published } : {}),
      subject, category, divisive, factLine, question, caption,
      why: typeof raw.why === "string" ? raw.why.trim().slice(0, 300) : "",
      flags: softHits(candidate.title, ...(candidate.context ?? [])),
      trending: candidate.trending === true,
      buzz: candidate.buzz ?? 0,
      expiresAt: candidate.expires ?? published + NEWS_POST_LIFETIME_H * 3600,
    },
  };
}

/**
 * Pre-filter candidates so unusable ones never reach the model: stale or undated, or hitting the
 * HARD blocklist (soft words are kept — the draft is flagged instead).
 */
export function filterCandidates(
  all: TopicCandidate[],
  now: Date = new Date(),
): { kept: TopicCandidate[]; blocked: number } {
  const nowSec = Math.floor(now.getTime() / 1000);
  const kept: TopicCandidate[] = [];
  let blocked = 0;
  for (const c of all) {
    const fresh = c.published !== undefined && nowSec - c.published <= MAX_CANDIDATE_AGE_H * 3600 && c.published - nowSec <= 7200;
    if (fresh && checkBrandSafety(c.title, ...(c.context ?? [])).safe) kept.push(c);
    else blocked++;
  }
  return { kept, blocked };
}

/** Best first: no sensitive flag, then widely covered (≥ 3 other headlines), then trending, then most divisive. */
export function rankPosts(posts: HotTopicPost[]): HotTopicPost[] {
  return [...posts].sort(
    (a, b) =>
      a.flags.length - b.flags.length ||
      Number((b.buzz ?? 0) >= 3) - Number((a.buzz ?? 0) >= 3) ||
      Number(b.trending) - Number(a.trending) ||
      b.divisive - a.divisive,
  );
}

export async function generateHotTopicPosts(all: TopicCandidate[], now = new Date()): Promise<GenerateOutcome> {
  const { kept, blocked } = filterCandidates(all, now);
  // Facts first, then the most-covered stories, then newest — the 40-item cut keeps what matters.
  const ordered = [...kept].sort(
    (a, b) => Number(b.kind === "fact") - Number(a.kind === "fact") || (b.buzz ?? 0) - (a.buzz ?? 0) || (b.published ?? 0) - (a.published ?? 0),
  );
  const candidates = ordered.slice(0, MAX_CANDIDATES_TO_LLM);
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
    const res = validateProposal(raw as RawProposal, candidates, now);
    if ("post" in res) posts.push(res.post);
    else rejected.push({ title: res.title, reason: res.reason });
  }
  return { posts: rankPosts(posts), blockedBeforeLlm: blocked, rejected, rawReply: text.slice(0, 6000) };
}
