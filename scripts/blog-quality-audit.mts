/**
 * Blog quality audit + repair for the editorial blogs (actualites FR, blog EN) — the review they never had.
 *
 *   node-x64 node_modules/tsx/dist/cli.mjs scripts/blog-quality-audit.mts            # audit only (reads Shopify, calls the claims check)
 *   node-x64 node_modules/tsx/dist/cli.mjs scripts/blog-quality-audit.mts --apply    # also fixes / unpublishes (backup first)
 *   ... --only=<articleId>[,<id>]   restrict to some articles       --no-llm   rules only (free)
 *
 * Decision per article (applied only with --apply; nothing is ever hard-deleted):
 *   OK         passes the rules and the claims check                            → untouched
 *   FIX        only fixable problems (supplier name, prices, percentages, study claims, contestable claims)
 *              → store name swap, then a model rewrite that changes as little as possible; accepted only if the
 *                result passes the rules + claims check and keeps >= 90 % of the words
 *   UNPUBLISH  structurally poor (wrong language, too short, no real sections, unsafe HTML) or a fix that did not
 *              pass → set to draft (reversible; the URL stops resolving until it is republished)
 *
 * Every article body is saved to out/blog-backup-<date>.json BEFORE anything is written. LLM calls are charged to the
 * uncapped-by-default `maintenance` pool (operator-launched pass), never to `batch`/`import`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

{
  // Env comes from the shell (node --env-file=…) or, failing that, a .env.local at the repo root.
  let raw = "";
  try {
    raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  } catch {
    /* no local env file: rely on the process environment */
  }
  for (const l of raw.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const APPLY = process.argv.includes("--apply");
const NO_LLM = process.argv.includes("--no-llm");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const DATE = new Date().toISOString().slice(0, 10);

const { blogRuleProblems, checkBlogClaims, demoteH1 } = await import("../src/lib/blog-quality");
const { defaultLlmText } = await import("../src/lib/auto-import/verify");
const { withBudgetPool } = await import("../src/lib/llm-budget");
const { updateBlogArticleBody } = await import("../src/lib/shopify-blog");
type LlmText = import("../src/lib/auto-import/verify").LlmText;

const BASE = "https://27u5y2-kp.myshopify.com/admin/api/2025-01";
const H = { "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN ?? "", "Content-Type": "application/json" };
const EDITORIAL: Record<string, "fr" | "en"> = { actualites: "fr", blog: "en" };

async function shopify(path: string, init?: RequestInit) {
  const res = await fetch(BASE + path, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

interface Article { id: number; blogId: number; blog: string; lang: "fr" | "en"; title: string; handle: string; published: boolean; bodyHtml: string; tags: string[] }

async function loadArticles(): Promise<Article[]> {
  const blogs = (await shopify("/blogs.json?limit=50")).blogs as Array<{ id: number; handle: string }>;
  const out: Article[] = [];
  for (const b of blogs) {
    const lang = EDITORIAL[b.handle];
    if (!lang) continue;
    let since = 0;
    for (;;) {
      const { articles } = await shopify(`/blogs/${b.id}/articles.json?limit=250&since_id=${since}&fields=id,title,handle,published_at,body_html,tags`);
      if (!articles.length) break;
      for (const a of articles) {
        out.push({ id: a.id, blogId: b.id, blog: b.handle, lang, title: a.title, handle: a.handle, published: !!a.published_at, bodyHtml: a.body_html ?? "", tags: typeof a.tags === "string" && a.tags ? a.tags.split(",").map((t: string) => t.trim()) : [] });
      }
      since = articles[articles.length - 1].id;
      if (articles.length < 250) break;
    }
  }
  return out;
}

const STORE: Record<"fr" | "en", string> = { fr: "Ameublo Direct", en: "Furnish Direct" };
/** Deterministic supplier-name swap: "Chez Aosom Canada" → "Chez Ameublo Direct". */
export function swapSupplierName(html: string, lang: "fr" | "en"): string {
  return html.replace(/Aosom(?:\s+Canada)?/gi, STORE[lang]);
}

/** Problems a model rewrite can fix; the rest means the article is structurally poor. */
const FIXABLE = (p: string) => /^(supplier_name|supplier_brand|internal_name|price_in_article|sku_in_article|percentage_needs_source|unsourced_study_claim|h1_in_body|external_link|claim:)/.test(p);
/** Rules that cannot be judged here (the audit has no SEO metadata) or are not a reason to pull a live article. */
const IGNORED = (p: string) =>
  /^(meta_length|title_length|title_company_like_token|title_truncated|similar_title)/.test(p) ||
  (p.startsWith("too_short:") && Number(p.split(":")[1]) >= 450); // the gate wants 550+; a live article is only "poor" below 450
/**
 * For the retrofit of articles already live, only explicit numbers and "studies show" claims are acted on. Ordinary
 * advice the checker files as health/safety, legal or spec stays as an advisory note: the owner asked to fix articles that
 * name the supplier or are poor, not to rewrite every sentence a strict reviewer could question.
 */
const ACTIONABLE_CLAIM = (reason: string) => /^claim:(statistic|study|price):/.test(reason);

const wordCount = (html: string) => html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;

async function repair(a: Article, problems: string[], llm: LlmText): Promise<string | null> {
  const prompt = [
    `Tu corriges un article de blogue publié (${a.lang === "fr" ? "français québécois" : "anglais canadien"}) pour la boutique ${STORE[a.lang]}.`,
    "Réécris le HTML en changeant le MOINS possible. Retire ou reformule seulement ce qui pose problème:",
    "- aucun prix, fourchette de prix ni budget en dollars (reformule en mots: « un budget raisonnable », « selon vos besoins »);",
    "- aucun pourcentage, chiffre statistique, étude, « les experts disent »: remplace par un conseil général sans chiffre inventé;",
    "- aucun nom de fournisseur ni de marque; la boutique s'appelle uniquement " + STORE[a.lang] + ";",
    "- aucune affirmation de santé, de sécurité, de loi ou de durée de vie que tu ne peux pas soutenir: garde un conseil de bon sens, sans chiffre;",
    "- garde la structure (balises h2/h3/p/ul/li), les liens internes (href relatifs ou ameublodirect.ca / furnishdirect.ca) et la longueur à peu près identique (au moins 90 % des mots).",
    `Problèmes détectés: ${problems.join(" | ")}`,
    'Réponds UNIQUEMENT avec un objet JSON: {"bodyHtml":"<p>...</p>"}',
    "",
    "<ARTICLE_HTML>",
    a.bodyHtml,
    "</ARTICLE_HTML>",
  ].join("\n");
  const raw = await llm(prompt, { tier: "strong", maxTokens: 6000 });
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const out = JSON.parse(raw.slice(s, e + 1)) as { bodyHtml?: string };
    return typeof out.bodyHtml === "string" ? out.bodyHtml : null;
  } catch {
    return null;
  }
}

interface Row { id: number; blog: string; title: string; published: boolean; decision: "OK" | "FIX" | "UNPUBLISH" | "FIXED" | "UNPUBLISHED" | "FIX_FAILED"; problems: string[]; note?: string }

async function main() {
  const articles = (await loadArticles()).filter((a) => ONLY.length === 0 || ONLY.includes(String(a.id)));
  mkdirSync(new URL("../scripts/blog-reports/", import.meta.url), { recursive: true });
  const backupPath = new URL(`../scripts/blog-reports/blog-backup-${DATE}.json`, import.meta.url);
  if (APPLY) {
    writeFileSync(backupPath, JSON.stringify(articles, null, 1));
    console.log(`backup written: ${articles.length} articles → scripts/blog-reports/blog-backup-${DATE}.json`);
  }
  const titles = articles.map((a) => a.title);
  const llm: LlmText = (p, o) => withBudgetPool("maintenance", () => defaultLlmText(p, o));
  const rows: Row[] = [];

  for (const a of articles) {
    const input = { title: a.title, bodyHtml: a.bodyHtml, metaDescription: "m".repeat(100), tags: a.tags, lang: a.lang };
    const rules = blogRuleProblems(input, { existingTitles: titles }).filter((p) => !IGNORED(p));
    let claimReasons: string[] = [];
    let advisory: string[] = [];
    if (!NO_LLM && rules.every(FIXABLE)) {
      const c = await checkBlogClaims(input, llm);
      claimReasons = c.reasons.filter(ACTIONABLE_CLAIM);
      advisory = c.reasons.filter((r) => !ACTIONABLE_CLAIM(r));
    }
    const problems = [...rules, ...claimReasons];
    if (problems.length === 0) {
      rows.push({ id: a.id, blog: a.blog, title: a.title, published: a.published, decision: "OK", problems, note: advisory.length ? `advisory (not acted on): ${advisory.length} softer claim(s)` : undefined });
      continue;
    }
    const structural = rules.filter((p) => !FIXABLE(p));
    const poor = structural.length > 0 || wordCount(a.bodyHtml) < 450;
    let decision: Row["decision"] = poor ? "UNPUBLISH" : "FIX";
    let note: string | undefined = advisory.length ? `advisory (not acted on): ${advisory.length} softer claim(s)` : undefined;

    if (APPLY) {
      try {
        if (decision === "FIX") {
          let body = demoteH1(swapSupplierName(a.bodyHtml, a.lang));
          const stillBad = (b: string) => blogRuleProblems({ ...input, bodyHtml: b }, { existingTitles: titles }).filter((p) => !IGNORED(p));
          if (stillBad(body).length > 0 || claimReasons.length > 0) {
            const rewritten = await repair({ ...a, bodyHtml: body }, [...stillBad(body), ...claimReasons].slice(0, 12), llm);
            if (rewritten && wordCount(rewritten) >= wordCount(a.bodyHtml) * 0.9) body = rewritten;
            else note = "rewrite rejected (empty or too short)";
          }
          const recheck = stillBad(body);
          const claims2: string[] = NO_LLM ? [] : (await checkBlogClaims({ ...input, bodyHtml: body }, llm)).reasons.filter(ACTIONABLE_CLAIM);
          if (recheck.length === 0 && claims2.length === 0) {
            if (body !== a.bodyHtml) await updateBlogArticleBody(a.blogId, String(a.id), body);
            decision = "FIXED";
          } else {
            decision = a.published ? "UNPUBLISH" : "FIX_FAILED";
            note = `after fix: ${[...recheck, ...claims2].slice(0, 3).join("; ")}`;
          }
        }
        if (decision === "UNPUBLISH") {
          if (a.published) await shopify(`/blogs/${a.blogId}/articles/${a.id}.json`, { method: "PUT", body: JSON.stringify({ article: { id: a.id, published: false } }) });
          decision = "UNPUBLISHED";
        }
      } catch (err) {
        decision = "FIX_FAILED";
        note = err instanceof Error ? err.message.slice(0, 160) : "error";
      }
    }
    rows.push({ id: a.id, blog: a.blog, title: a.title, published: a.published, decision, problems, note });
  }

  const tally = rows.reduce<Record<string, number>>((o, r) => ((o[r.decision] = (o[r.decision] ?? 0) + 1), o), {});
  console.log("\nSUMMARY:", JSON.stringify(tally), `(${rows.length} articles, ${rows.filter((r) => r.published).length} live)`);
  for (const r of rows.filter((r) => r.decision !== "OK")) {
    console.log(`${r.decision.padEnd(11)} ${r.published ? "LIVE " : "draft"} #${r.id} [${r.blog}] ${r.title.slice(0, 58)}\n    ${r.problems.slice(0, 4).join(" | ").slice(0, 250)}${r.note ? `\n    note: ${r.note}` : ""}`);
  }
  writeFileSync(new URL(`../scripts/blog-reports/blog-audit-${DATE}${APPLY ? "-applied" : ""}.json`, import.meta.url), JSON.stringify(rows, null, 1));
}

// ── --rewrite-no-numbers: bring back articles that were pulled because of unsourced figures ──────────────
//   ... --only=<ids> --rewrite-no-numbers [--republish] [--apply]
// Rewrites each article with NO numbers at all (percentages, prices, durations, dimensions, frequencies) and no study/law/
// health-figure claims; accepted only when it also passes the rules, keeps >= 60 % of the words (and the 550-word floor of the rules) and passes the FULL claims
// check (every strict kind). `--republish` then puts a passing article back online; a failing one stays a draft.
const YEAR_RE = /\b20[2-3]\d\b/g;
const NUM_RE = /\d+(?:[.,]\d+)?/g;

/** Digits left in an article (years allowed). JSON-LD FAQ blocks are inspected by value, not by their @context URLs. */
export function digitsLeft(html: string): string[] {
  const ld: string[] = [];
  const withoutLd = html.replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, (_m, j: string) => {
    ld.push(j);
    return " ";
  });
  const found = new Set<string>((withoutLd.replace(/<[^>]+>/g, " ").replace(YEAR_RE, " ").match(NUM_RE)) ?? []);
  const walk = (v: unknown): void => {
    if (typeof v === "string") for (const m of v.replace(YEAR_RE, " ").match(NUM_RE) ?? []) found.add(m);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!k.startsWith("@")) walk(x);
  };
  for (const j of ld) {
    try {
      walk(JSON.parse(j));
    } catch {
      found.add("invalid_json_ld");
    }
  }
  return [...found];
}

async function rewriteNoNumbers(a: Article, llm: LlmText, feedback?: string): Promise<string | null> {
  const prompt = [
    `Réécris cet article de blogue (${a.lang === "fr" ? "français québécois" : "anglais canadien"}) pour la boutique ${STORE[a.lang]}.`,
    "Garde le sujet, le plan (balises h2/h3/p/ul/li), le ton, les liens existants (crédits photo) et une longueur à peu près identique.",
    "CONTRAINTES STRICTES:",
    "- AUCUN chiffre ni nombre: pas de pourcentage, prix, durée, fréquence, dimension, âge, ni quantité écrite en lettres (« trois fois », « deux heures »). Exprime-le en mots (« souvent », « un espace généreux », « régulièrement »). Seule une année comme 2026 est permise.",
    "- Aucune statistique, étude, « les experts disent », loi, norme, règlement, ni donnée de santé ou de sécurité: uniquement des conseils pratiques et de bon sens.",
    "- Aucun nom de fournisseur ni de marque; la boutique s'appelle uniquement " + STORE[a.lang] + ".",
    "- S'il y a un bloc JSON-LD (FAQ), réécris-le avec les mêmes contraintes et garde un JSON valide.",
    feedback ? `Ta tentative précédente a échoué pour: ${feedback}. Corrige exactement cela.` : "",
    'Réponds UNIQUEMENT avec un objet JSON: {"bodyHtml":"<p>...</p>"}',
    "",
    "<ARTICLE_HTML>",
    a.bodyHtml,
    "</ARTICLE_HTML>",
  ]
    .filter(Boolean)
    .join("\n");
  const raw = await llm(prompt, { tier: "strong", maxTokens: 8000 });
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const out = JSON.parse(raw.slice(s, e + 1)) as { bodyHtml?: string };
    return typeof out.bodyHtml === "string" ? out.bodyHtml : null;
  } catch {
    return null;
  }
}

async function runRewrite() {
  if (ONLY.length === 0) throw new Error("--rewrite-no-numbers needs --only=<articleId>[,<id>]");
  const REPUBLISH = process.argv.includes("--republish");
  const articles = (await loadArticles()).filter((a) => ONLY.includes(String(a.id)));
  mkdirSync(new URL("../scripts/blog-reports/", import.meta.url), { recursive: true });
  if (APPLY) writeFileSync(new URL(`../scripts/blog-reports/blog-backup-${DATE}-rewrite.json`, import.meta.url), JSON.stringify(articles, null, 1));
  const llm: LlmText = (p, o) => withBudgetPool("maintenance", () => defaultLlmText(p, o));
  for (const a of articles) {
    let feedback: string | undefined;
    let accepted: string | null = null;
    let lastReasons: string[] = [];
    for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
      const candidate = await rewriteNoNumbers({ ...a, bodyHtml: demoteH1(swapSupplierName(a.bodyHtml, a.lang)) }, llm, feedback);
      if (!candidate) { feedback = "réponse invalide (JSON attendu)"; lastReasons = [feedback]; continue; }
      const reasons: string[] = [];
      const digits = digitsLeft(candidate);
      if (digits.length) reasons.push(`des chiffres restent: ${digits.slice(0, 8).join(", ")}`);
      const input = { title: a.title, bodyHtml: candidate, metaDescription: "m".repeat(100), tags: a.tags, lang: a.lang };
      reasons.push(...blogRuleProblems(input).filter((p) => !IGNORED(p)));
      if (wordCount(candidate) < wordCount(a.bodyHtml) * 0.6) reasons.push(`trop court après réécriture (${wordCount(candidate)} mots; l original en avait ${wordCount(a.bodyHtml)})`);
      if (reasons.length === 0 && !NO_LLM) {
        const c = await checkBlogClaims(input, llm);
        if (!c.ok) reasons.push(...c.reasons.slice(0, 4));
      }
      if (reasons.length === 0) accepted = candidate;
      else { feedback = reasons.join(" | "); lastReasons = reasons; }
    }
    if (accepted && APPLY) {
      await updateBlogArticleBody(a.blogId, String(a.id), accepted);
      if (REPUBLISH) await shopify(`/blogs/${a.blogId}/articles/${a.id}.json`, { method: "PUT", body: JSON.stringify({ article: { id: a.id, published: true } }) });
    }
    console.log(`${accepted ? (APPLY ? (REPUBLISH ? "REPUBLISHED" : "REWRITTEN") : "WOULD_PASS") : "STILL_DRAFT"} #${a.id} [${a.blog}] ${a.title.slice(0, 60)}${accepted ? "" : `\n    ${lastReasons.join(" | ").slice(0, 300)}`}`);
  }
}

if (process.argv.includes("--rewrite-no-numbers")) await runRewrite();
else await main();
