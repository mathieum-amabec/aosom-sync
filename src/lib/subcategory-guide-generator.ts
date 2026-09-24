/**
 * pSEO subcategory guide pages — Phase 1 of the organic-growth plan. Anchored on real Turso
 * data (trend score, real price range, real in-stock count, real product comparison), never
 * generic template filler. Every guide is created as a Shopify blog article via
 * createBlogArticle, which ALWAYS sets `published: false` — there is no code path in this
 * module that can make a page go live; that stays a manual Shopify admin action for Mat.
 *
 * Respects the plan's 5 anti-doorway rules:
 *   1. Unique structured data per URL — see buildDataBlockHtml + buildJsonLd.
 *   2. Intro/conclusion are a first Claude draft, wrapped in a visible "BROUILLON" banner
 *      that only disappears if a human edits the article before publishing.
 *   3. A real user task — the "Comment choisir" decision-aid section, anchored on the actual
 *      compared products, not a generic listicle.
 *   4. Pillar-guide linking — see PILLAR_GUIDE_URL below. None exists yet; this module does
 *      NOT invent one, it flags the gap (checked at generation time, surfaced in the result).
 *   5. Empty pages never get created — selectPilotSubcategories skips (and records why) any
 *      subcategory that can't support a real 2-3 product comparison.
 *
 * Every generated guide also runs through the 3-pass quality pipeline (guide-quality-pipeline.ts)
 * BEFORE being pushed to Shopify — fact-check + tone/brand judge, mirroring blog-auto-publish.ts's
 * scoreArticle pattern. The verdict never blocks the push (a low score still needs a real human
 * look, not a silent drop), it's stored alongside the article so the review dashboard can surface
 * it instead of Mat re-reading every word.
 */
import { getAnthropicClient, slugify } from "./content-generator";
import { stripSupplierBrands } from "@/lib/catalog-guard";
import { budgetedCreate } from "@/lib/llm-budget";
import { CLAUDE, BLOG } from "./config";
import {
  getSubcategoryTrendStats,
  createGuidePage,
  getAllCollectionMappings,
  getGuidePages,
  type SubcategoryTrendStats,
} from "./database";
import { getShopifyProductTitle, getShopifyCollectionHandle } from "./shopify-client";
import { resolveLifestyle } from "./selectors/shopify-images";
import { createBlogArticle } from "./shopify-blog";
import { runGuideQualityPipeline } from "./guide-quality-pipeline";

const STORE_ORIGIN = "https://ameublodirect.ca";

/**
 * No hand-written pillar guide exists yet (verified against docs/seo-articles/ — the 10
 * existing articles are topical comparisons, none positioned or written as a pillar/hub page,
 * and none has ever been published). Per the plan's own rule #4, this module does NOT invent
 * a substitute — it links to the real Shopify collection page as the closest existing hub
 * instead, and every generated guide's result flags `pillarGuideMissing: true` so this stays
 * visible rather than silently working around a real prerequisite gap.
 */
const PILLAR_GUIDE_URL: string | null = null;

const MIN_PRODUCTS_FOR_COMPARISON = 2;

export interface GuideCandidate {
  stats: SubcategoryTrendStats;
  titles: string[]; // real Shopify FR titles, same order as stats.topProducts
  collectionHandle: string | null;
}

export interface SkippedSubcategory {
  aosomCategory: string;
  shopifyCollectionId: string;
  shopifyCollectionTitle: string;
  reason: string;
}

export interface GuideCoverageStatus {
  totalSubcategories: number;
  coveredCount: number;
  remainingCount: number;
  excludeCategories: Set<string>;
}

/**
 * How many of the real 'sub' subcategories (collection_mappings) still have no guide_pages
 * row at all — the stop condition for the weekly batch cron. A subcategory counts as
 * "covered" regardless of its guide_pages status (pending_review, published, or even
 * skipped_empty for a permanently-blocked stale collection mapping) — once a row exists, a
 * later run must never try it again, matching selectPilotSubcategories' own exclusion rule.
 */
export async function getGuideCoverageStatus(): Promise<GuideCoverageStatus> {
  const [mappings, guides] = await Promise.all([getAllCollectionMappings(), getGuidePages()]);
  const subCategories = mappings.filter((m) => m.collectionRole === "sub").map((m) => m.aosomCategory);
  const excludeCategories = new Set(guides.map((g) => g.aosom_category));
  const remaining = subCategories.filter((c) => !excludeCategories.has(c));
  return {
    totalSubcategories: subCategories.length,
    coveredCount: subCategories.length - remaining.length,
    remainingCount: remaining.length,
    excludeCategories,
  };
}

/**
 * Walks the trend-ranked subcategory list and accepts up to `count`, skipping (with a logged
 * reason, never silently) any subcategory that can't support a real comparison. Does NOT stop
 * at the first `count` in ranked order if some of those are skipped — it keeps walking so a
 * pilot of N always tries to actually produce N pages when the catalog can support it.
 *
 * `excludeCategories` skips any aosom_category already present in guide_pages (any status —
 * pending_review, skipped_empty, or published), so a second batch run never regenerates a
 * duplicate for a subcategory a prior run already covered.
 */
export async function selectPilotSubcategories(
  count: number,
  excludeCategories: Set<string> = new Set(),
): Promise<{ candidates: GuideCandidate[]; skipped: SkippedSubcategory[] }> {
  const allStats = await getSubcategoryTrendStats();
  const candidates: GuideCandidate[] = [];
  const skipped: SkippedSubcategory[] = [];

  for (const stats of allStats) {
    if (candidates.length >= count) break;
    if (excludeCategories.has(stats.aosomCategory)) continue;

    if (stats.topProducts.length < MIN_PRODUCTS_FOR_COMPARISON) {
      skipped.push({
        aosomCategory: stats.aosomCategory,
        shopifyCollectionId: stats.shopifyCollectionId,
        shopifyCollectionTitle: stats.shopifyCollectionTitle,
        reason: `Seulement ${stats.topProducts.length} produit(s) en stock — impossible de former un comparatif réel (minimum ${MIN_PRODUCTS_FOR_COMPARISON}).`,
      });
      continue;
    }

    const collectionHandle = await getShopifyCollectionHandle(stats.shopifyCollectionId);
    if (!collectionHandle) {
      skipped.push({
        aosomCategory: stats.aosomCategory,
        shopifyCollectionId: stats.shopifyCollectionId,
        shopifyCollectionTitle: stats.shopifyCollectionTitle,
        reason: `collection_mappings pointe vers shopify_collection_id=${stats.shopifyCollectionId}, qui n'existe plus sur Shopify (404) — la collection a été supprimée/reconstruite depuis. À corriger dans collection_mappings avant de pouvoir générer cette page (pas un problème de données produit).`,
      });
      continue;
    }

    const titles = await Promise.all(
      stats.topProducts.map((p) => getShopifyProductTitle(p.shopify_product_id, p.name)),
    );

    candidates.push({ stats, titles, collectionHandle });
  }

  return { candidates, skipped };
}

interface GuideCopy {
  introHtml: string;
  comparisonIntroHtml: string;
  chooseHtml: string;
  conclusionHtml: string;
  faq: { question: string; answer: string }[];
}

const COPY_SYSTEM_PROMPT = `Tu écris le contenu éditorial d'un guide d'achat pour Ameublo Direct, boutique québécoise de meubles et décoration (marché Québec, français primaire, vouvoiement).

TON : direct, utile, concret — pas de survente, pas de superlatifs vides. Tu aides vraiment quelqu'un à choisir, tu ne vends pas.

RÈGLES ABSOLUES :
- INTERDIT de nommer un fournisseur ou une marque manufacturière (jamais "Outsunny", "HOMCOM", "Aosom", "PawHut", "Vinsetto", "Qaba", etc.) — seulement "Ameublo Direct".
- N'invente AUCUNE caractéristique produit que tu ne connais pas — utilise uniquement les noms, prix et faits fournis dans le prompt.
- Aucune fausse urgence, aucune fausse rareté.
- Réponds UNIQUEMENT avec un objet JSON valide, sans balises markdown, avec exactement ces clés :
  {
    "introHtml": "<p>...</p> — 2-3 phrases, accroche + pourquoi ce guide est utile",
    "comparisonIntroHtml": "<p>...</p> — 1-2 phrases qui introduisent le tableau comparatif ci-dessous",
    "chooseHtml": "<p>...</p><ul><li>...</li></ul> — une vraie aide à la décision : 2-3 critères concrets (budget, usage, espace) et pour chacun, lequel des produits comparés convient le mieux et pourquoi",
    "conclusionHtml": "<p>...</p> — 2-3 phrases de conclusion avec un appel à l'action naturel vers la collection",
    "faq": [{"question": "...", "answer": "..."}] — exactement 3 questions/réponses concrètes et utiles, pas génériques
  }
Chaque champ HTML doit être du HTML simple valide (p, ul, li, strong) — pas de classes, pas de style inline, pas de markdown.`;

function buildCopyUserPrompt(stats: SubcategoryTrendStats, titles: string[]): string {
  const productLines = stats.topProducts
    .map((p, i) => `- ${titles[i]} — ${p.price.toFixed(2)} $ CAD`)
    .join("\n");

  return `Sous-catégorie : ${stats.shopifyCollectionTitle}
Fourchette de prix réelle : ${stats.minPrice.toFixed(2)} $ à ${stats.maxPrice.toFixed(2)} $ CAD
Nombre de produits en stock : ${stats.inStockCount}

Produits à comparer (réels, dans cet ordre) :
${productLines}

Écris le contenu du guide d'achat pour cette sous-catégorie, en te basant uniquement sur ces faits réels.`;
}

async function generateGuideCopy(stats: SubcategoryTrendStats, titles: string[]): Promise<GuideCopy> {
  const client = getAnthropicClient();
  const message = await budgetedCreate(client, {
    model: CLAUDE.MODEL_BATCH,
    max_tokens: 1500,
    system: COPY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildCopyUserPrompt(stats, titles) }],
  });
  if (!message.content.length || message.content[0].type !== "text" || !message.content[0].text.trim()) {
    throw new Error("[guide] copy generation returned empty content");
  }
  console.log(`[guide] generation usage: input=${message.usage.input_tokens} output=${message.usage.output_tokens}`);
  const text = message.content[0].text;
  const jsonStr = text.replace(/^```json?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`[guide] copy generation returned invalid JSON: ${text.slice(0, 150)}`);
  }
  const p = parsed as Record<string, unknown>;
  const scrub = (s: unknown) => stripSupplierBrands(typeof s === "string" ? s : "");
  const faqRaw = Array.isArray(p.faq) ? p.faq : [];

  return {
    introHtml: scrub(p.introHtml),
    comparisonIntroHtml: scrub(p.comparisonIntroHtml),
    chooseHtml: scrub(p.chooseHtml),
    conclusionHtml: scrub(p.conclusionHtml),
    faq: faqRaw
      .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
      .map((f) => ({ question: scrub(f.question), answer: scrub(f.answer) }))
      .filter((f) => f.question && f.answer)
      .slice(0, 4),
  };
}

const DRAFT_BANNER_HTML = `<div style="border:2px solid #D4A853;background:#FFF8E7;color:#1A2340;padding:16px;margin-bottom:24px;border-radius:8px;font-family:sans-serif">
<strong>⚠️ BROUILLON — Ne pas publier sans relecture</strong><br>
L'introduction, la section « comment choisir » et la conclusion ci-dessous sont un premier jet généré par IA — à valider/ajuster par Mat avant toute mise en ligne. Les données produits (prix, stock, tendance) sont réelles et vérifiées automatiquement, pas générées.
</div>`;

function money(n: number): string {
  return n.toFixed(2).replace(".", ",") + " $";
}

function buildDataBlockHtml(stats: SubcategoryTrendStats): string {
  // "forte demande" was an overstatement for ANY velocityScore > 0 (even a single unit moved)
  // — the fact-check judge correctly flagged it as unsupported by the actual signal strength
  // (real finding, 2026-09-23: Patio & Garden > Camping Supplies scored 62/100 on this exact
  // phrase). Neutral, always-true wording instead of a strength claim the data doesn't back.
  const trendLabel = stats.priceDropScore > 0.05
    ? `des rabais actifs pouvant atteindre ${Math.round(stats.priceDropScore * 100)} %`
    : stats.velocityScore > 0
      ? "des mouvements de stock récents"
      : "une sélection stable";
  return `<div style="background:#F5F3EE;padding:16px;border-radius:8px;margin:16px 0">
<p><strong>En bref :</strong> ${stats.inStockCount} produits actuellement en stock dans cette catégorie,
de ${money(stats.minPrice)} à ${money(stats.maxPrice)} CAD, avec ${trendLabel}.</p>
</div>`;
}

function buildComparisonHtml(stats: SubcategoryTrendStats, titles: string[], images: (string | null)[]): string {
  const rows = stats.topProducts
    .map((p, i) => {
      const url = `${STORE_ORIGIN}/products/${p.shopify_handle}`;
      const img = images[i]
        ? `<img src="${images[i]}" alt="${titles[i]}" style="width:64px;height:64px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:8px">`
        : "";
      return `<tr><td>${img}<a href="${url}">${titles[i]}</a></td><td>${money(p.price)}</td></tr>`;
    })
    .join("\n");
  return `<table style="width:100%;border-collapse:collapse;margin:16px 0">
<thead><tr><th style="text-align:left;border-bottom:1px solid #ccc">Produit</th><th style="text-align:left;border-bottom:1px solid #ccc">Prix</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function buildFaqHtml(faq: GuideCopy["faq"]): string {
  if (faq.length === 0) return "";
  const items = faq.map((f) => `<h3>${f.question}</h3><p>${f.answer}</p>`).join("\n");
  return `<h2>Questions fréquentes</h2>\n${items}`;
}

function buildJsonLd(
  stats: SubcategoryTrendStats,
  titles: string[],
  images: (string | null)[],
  collectionHandle: string,
  faq: GuideCopy["faq"],
  guideTitle: string,
): string {
  const collectionUrl = `${STORE_ORIGIN}/collections/${collectionHandle}`;
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: stats.topProducts.map((p, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Product",
        name: titles[i],
        url: `${STORE_ORIGIN}/products/${p.shopify_handle}`,
        ...(images[i] ? { image: images[i] } : {}),
        brand: { "@type": "Brand", name: "Ameublo Direct" },
        offers: {
          "@type": "Offer",
          priceCurrency: "CAD",
          price: p.price.toFixed(2),
          availability: "https://schema.org/InStock",
        },
      },
    })),
  };
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Accueil", item: `${STORE_ORIGIN}/` },
      { "@type": "ListItem", position: 2, name: stats.shopifyCollectionTitle, item: collectionUrl },
      { "@type": "ListItem", position: 3, name: guideTitle, item: collectionUrl },
    ],
  };
  const blocks: Record<string, unknown>[] = [itemList, breadcrumb];
  if (faq.length > 0) {
    blocks.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faq.map((f) => ({
        "@type": "Question",
        name: f.question,
        acceptedAnswer: { "@type": "Answer", text: f.answer },
      })),
    });
  }
  return blocks.map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join("\n");
}

export interface GeneratedGuideResult {
  aosomCategory: string;
  title: string;
  shopifyArticleId: string;
  shopifyHandle: string;
  adminUrl: string;
  pillarGuideMissing: boolean;
}

/** Generates and pushes ONE guide as a Shopify draft article (never published). Throws on
 * hard failure (Claude/Shopify errors) — caller (generatePilotGuides) catches per-candidate
 * so one failure doesn't abort the rest of the pilot batch. */
export async function generateAndPushGuide(candidate: GuideCandidate): Promise<GeneratedGuideResult> {
  const { stats, titles, collectionHandle } = candidate;
  if (!collectionHandle) throw new Error(`[guide] no collection handle for ${stats.aosomCategory}`);

  const copy = await generateGuideCopy(stats, titles);

  // Real Shopify-CDN product photos (never the raw Aosom-CDN urls, which 403 outside Shopify) —
  // same resolveLifestyle() already used for social posts (job4-social.ts). Doesn't require the
  // strict lifestyle-verified tag: a plain clean position-1 product photo is enough for a
  // comparison thumbnail. Resolved in parallel, one failure doesn't drop the others.
  const images = await Promise.all(
    stats.topProducts.map(async (p) => {
      try {
        const life = await resolveLifestyle(p.shopify_product_id);
        return life.primaryImageUrl || null;
      } catch {
        return null;
      }
    }),
  );

  // 3-pass quality pipeline (fact-check + tone/brand judge) — never blocks the push, just
  // records the verdict so the review dashboard can surface it instead of Mat re-reading
  // every guide word-for-word.
  let verdict: import("./guide-quality-pipeline").QualityPipelineResult | null = null;
  try {
    verdict = await runGuideQualityPipeline(stats, titles, copy);
  } catch (err) {
    console.error(`[guide] quality pipeline failed for ${stats.aosomCategory}:`, err);
  }

  // Several DISTINCT aosom_category rows can share the same shopify_collection_id/title (the
  // internal taxonomy is more granular than the Shopify collection structure — e.g. "Fire
  // Pits", "Lawn & Garden" and "Patio Shade" all roll up to the single real collection
  // "Mobiliers extérieurs et jardins"). A title/handle built from the collection title alone
  // collides in that case. Primary attempt still uses the clean collection-title slug (the
  // common, non-colliding case); on a real Shopify "handle already taken" conflict, retry
  // once with the aosom_category's own leaf segment appended — deterministic, always unique
  // (aosom_category is collection_mappings' own primary key), never a guess.
  const baseTitle = `Comment choisir : ${stats.shopifyCollectionTitle} — guide d'achat`;
  const baseHandle = `guide-achat-${slugify(stats.shopifyCollectionTitle)}`;
  const leafSegment = stats.aosomCategory.split(" > ").pop() || "";
  const collectionUrl = `${STORE_ORIGIN}/collections/${collectionHandle}`;

  const pillarLinkHtml = PILLAR_GUIDE_URL
    ? `<p>Pour une vue d'ensemble, consultez aussi notre <a href="${PILLAR_GUIDE_URL}">guide complet</a>.</p>`
    : `<!-- Aucun guide pilier n'existe encore pour ce sujet — maillage vers le guide pilier à ajouter une fois qu'il existera (voir plan Phase 1, règle 4). -->`;

  const bodyHtml = [
    DRAFT_BANNER_HTML,
    copy.introHtml,
    buildDataBlockHtml(stats),
    copy.comparisonIntroHtml,
    buildComparisonHtml(stats, titles, images),
    `<h2>Comment choisir</h2>`,
    copy.chooseHtml,
    buildFaqHtml(copy.faq),
    copy.conclusionHtml,
    `<p>Voir toute la sélection : <a href="${collectionUrl}">${stats.shopifyCollectionTitle}</a>.</p>`,
    pillarLinkHtml,
    buildJsonLd(stats, titles, images, collectionHandle, copy.faq, baseTitle),
  ]
    .filter(Boolean)
    .join("\n\n");

  const metaDescription = `Comparatif ${stats.shopifyCollectionTitle.toLowerCase()} : ${stats.inStockCount} produits en stock, de ${money(stats.minPrice)} à ${money(stats.maxPrice)}. Guide d'achat Ameublo Direct.`.slice(0, 320);

  const firstImage = images.find((u): u is string => !!u);

  const isHandleTakenError = (err: unknown): boolean =>
    err instanceof Error && err.message.includes("422") && err.message.includes("has already been taken");

  let created;
  try {
    created = await createBlogArticle({
      title: baseTitle,
      bodyHtml,
      lang: "fr",
      blogIdOverride: BLOG.GUIDES_FR_ID,
      metaDescription,
      tags: ["guide-achat", "pseo-pilot"],
      handle: baseHandle,
      ...(firstImage ? { featuredImage: { src: firstImage, alt: baseTitle } } : {}),
    });
  } catch (err) {
    if (!isHandleTakenError(err)) throw err;
    const disambiguatedHandle = `${baseHandle}-${slugify(leafSegment)}`;
    const disambiguatedTitle = `Comment choisir : ${stats.shopifyCollectionTitle} (${leafSegment}) — guide d'achat`;
    created = await createBlogArticle({
      title: disambiguatedTitle,
      bodyHtml,
      lang: "fr",
      blogIdOverride: BLOG.GUIDES_FR_ID,
      metaDescription,
      tags: ["guide-achat", "pseo-pilot"],
      handle: disambiguatedHandle,
      ...(firstImage ? { featuredImage: { src: firstImage, alt: disambiguatedTitle } } : {}),
    });
  }
  const title = created.handle === baseHandle ? baseTitle : `Comment choisir : ${stats.shopifyCollectionTitle} (${leafSegment}) — guide d'achat`;

  await createGuidePage({
    aosomCategory: stats.aosomCategory,
    shopifyCollectionId: stats.shopifyCollectionId,
    shopifyCollectionTitle: stats.shopifyCollectionTitle,
    status: "pending_review",
    shopifyArticleId: created.articleId,
    shopifyBlogId: created.blogId,
    shopifyHandle: created.handle,
    title,
    bodyHtml,
    factCheckScore: verdict?.factCheck.score,
    factCheckIssues: verdict?.factCheck.reasons,
    qualityScore: verdict?.qualityCheck.score,
    qualityReasons: verdict?.qualityCheck.reasons,
    overallStatus: verdict?.overallStatus,
    minPrice: stats.minPrice,
    maxPrice: stats.maxPrice,
    inStockCount: stats.inStockCount,
  });

  return {
    aosomCategory: stats.aosomCategory,
    title,
    shopifyArticleId: created.articleId,
    shopifyHandle: created.handle,
    adminUrl: created.adminUrl,
    pillarGuideMissing: !PILLAR_GUIDE_URL,
  };
}

export interface PilotBatchResult {
  generated: GeneratedGuideResult[];
  skipped: SkippedSubcategory[];
  failed: { aosomCategory: string; error: string }[];
}

/**
 * Full pilot entry point: select up to `count` real candidates, generate + push each as a
 * Shopify draft, record every skip (empty data) and failure (generation/API error) instead of
 * silently dropping them. Never publishes anything.
 *
 * `excludeCategories` — see selectPilotSubcategories. Used to run a second/third batch without
 * regenerating subcategories an earlier run already covered.
 */
export async function generatePilotGuides(
  count: number,
  excludeCategories: Set<string> = new Set(),
): Promise<PilotBatchResult> {
  const { candidates, skipped } = await selectPilotSubcategories(count, excludeCategories);

  for (const s of skipped) {
    await createGuidePage({
      aosomCategory: s.aosomCategory,
      shopifyCollectionId: s.shopifyCollectionId,
      shopifyCollectionTitle: s.shopifyCollectionTitle,
      status: "skipped_empty",
      skipReason: s.reason,
    });
  }

  const generated: GeneratedGuideResult[] = [];
  const failed: { aosomCategory: string; error: string }[] = [];

  for (const candidate of candidates) {
    try {
      generated.push(await generateAndPushGuide(candidate));
    } catch (err) {
      failed.push({
        aosomCategory: candidate.stats.aosomCategory,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { generated, skipped, failed };
}
