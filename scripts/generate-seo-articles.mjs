/**
 * SEO/AEO article generator (DRY-RUN — local markdown only, no Shopify push).
 *
 * Usage:
 *   node scripts/generate-seo-articles.mjs <n>      # generate topic #n (1-based)
 *   node scripts/generate-seo-articles.mjs all       # generate all (2s between calls)
 *
 * Requires ANTHROPIC_API_KEY in the environment.
 * Writes docs/seo-articles/<slug>.md
 */
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4000;
const RATE_LIMIT_MS = 2000;
const STORE = "https://ameublodirect.ca";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "seo-articles");

// Derive a Shopify-style handle from a FR collection title (UNVERIFIED — handles
// are not stored in collection_mappings, only titles; verify before any publish).
const slugify = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const col = (title) => ({ title, url: `${STORE}/collections/${slugify(title)}`, verified: false });

// Approved list (Mat), each anchored to a real product_type + real FR collection names.
const TOPICS = [
  { n: 1, category: "Mobilier extérieur", intention: "Comparatif",
    title: "Parasol déporté ou parasol droit : lequel choisir pour votre terrasse?",
    slug: "parasol-deporte-ou-droit-terrasse",
    links: [col("Mobiliers extérieurs et jardins"), col("Chaises et tables de patio")] },
  { n: 2, category: "Mobilier extérieur", intention: "How-to",
    title: "Comment entretenir vos meubles de patio en résine tressée tout l'été",
    slug: "entretien-meubles-patio-resine-tressee",
    links: [col("Mobiliers extérieurs et jardins"), col("Chaises et tables de patio")] },
  { n: 3, category: "Mobilier extérieur", intention: "Informationnel",
    title: "Gazebo, pergola ou abri pop-up : quel abri choisir selon votre cour",
    slug: "gazebo-pergola-abri-pop-up-choisir",
    links: [col("Gazébos et abris extérieurs"), col("Mobiliers extérieurs et jardins")] },
  { n: 4, category: "Meubles", intention: "Comparatif",
    title: "Sofa sectionnel ou causeuse : comment choisir selon votre salon",
    slug: "sofa-sectionnel-ou-causeuse-salon",
    links: [col("Fauteuils et canapés"), col("Salon")] },
  { n: 5, category: "Meubles", intention: "How-to",
    title: "Comment organiser une petite entrée : 7 idées de rangement à chaussures",
    slug: "organiser-petite-entree-rangement-chaussures",
    links: [col("Entrée et vestibule"), col("Meubles et décorations")] },
  { n: 6, category: "Meubles", intention: "Informationnel",
    title: "Îlot de cuisine sur roulettes : bon choix pour une petite cuisine?",
    slug: "ilot-cuisine-roulettes-petite-cuisine",
    links: [col("Cuisine et salle à manger"), col("Meubles et décorations")] },
  { n: 7, category: "Animaux", intention: "How-to",
    title: "Comment choisir un arbre à chat selon la taille et l'âge de votre chat",
    slug: "choisir-arbre-a-chat-taille-age",
    links: [col("Chats"), col("Accessoires pour animaux")] },
  { n: 8, category: "Animaux", intention: "Comparatif",
    title: "Poulailler ou clapier : bien choisir l'habitat extérieur de vos petits animaux",
    slug: "poulailler-ou-clapier-habitat-exterieur",
    links: [col("Accessoires pour animaux"), col("Mobiliers extérieurs et jardins")] },
  { n: 9, category: "Enfants", intention: "Informationnel",
    title: "Voiture électrique pour enfant : âge, sécurité et autonomie expliqués",
    slug: "voiture-electrique-enfant-age-securite-autonomie",
    links: [col("Jouets pour enfants"), col("Meubles pour enfants")] },
  { n: 10, category: "Enfants", intention: "How-to",
    title: "Comment aménager une aire de jeu sécuritaire dans votre cour",
    slug: "amenager-aire-de-jeu-securitaire-cour",
    links: [col("Jouets pour enfants"), col("Mobiliers extérieurs et jardins")] },
];

const SYSTEM = `Tu es un rédacteur web québécois pour une boutique de meubles et d'articles
pour la maison (marché Québec, français primaire). Tu écris un contenu éditorial utile,
crédible et concret — JAMAIS de la survente.

RÈGLES ABSOLUES :
- Ton québécois, professionnel et chaleureux. Phrases claires, vouvoiement.
- INTERDIT de nommer un fournisseur ou une marque (jamais "Outsunny", "HOMCOM", "Aosom",
  "Vevor" ni aucune autre marque). Parle des produits par leur type générique.
- PAS de survente : pas de "le meilleur", "incroyable", "révolutionnaire", pas de pression.
- L'expression « livraison gratuite » : au PLUS une seule fois dans tout l'article (idéalement zéro).
- Aucune image, aucune référence d'image.
- Intègre naturellement, dans le corps, 2 à 3 liens internes en markdown vers les URLs
  de collection fournies (ancre descriptive, pas "cliquez ici").
- Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans bloc de code.`;

function buildPrompt(t) {
  const linkList = t.links.map((l) => `- ${l.title} → ${l.url}`).join("\n");
  return `Rédige un article de blogue (intention : ${t.intention}, catégorie : ${t.category}).

Titre exact (ne le change pas) : "${t.title}"

Liens internes à intégrer dans le corps (2 à 3, en markdown, ancre descriptive) :
${linkList}

Renvoie un JSON avec EXACTEMENT ces clés :
{
  "intro": "introduction d'environ 150 mots (texte simple, sans titre)",
  "body_markdown": "le corps en markdown structuré avec des ## (H2) et des ### (H3) ; intègre ici les 2-3 liens internes ; ${t.intention === "How-to" ? "format étapes/conseils concrets" : t.intention === "Comparatif" ? "compare les options de façon équilibrée avec leurs cas d'usage" : "explique clairement les notions clés"}",
  "faq": [{"question": "...", "answer": "..."}],
  "meta_description": "méta-description incitative, 155 caractères MAXIMUM"
}

La FAQ doit contenir 4 à 6 vraies questions que les gens se posent (style moteur de réponse / AEO).
Le corps doit faire environ 600 à 900 mots.`;
}

function stripFences(s) {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function faqJsonLd(faq) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((f) => ({
      "@type": "Question",
      name: f.question,
      acceptedAnswer: { "@type": "Answer", text: f.answer },
    })),
  }, null, 2);
}

function checks(t, art, fullText) {
  const issues = [];
  const supplier = fullText.match(/\b(outsunny|homcom|aosom|vevor)\b/gi);
  if (supplier) issues.push(`nom(s) fournisseur détecté(s) : ${[...new Set(supplier.map((s) => s.toLowerCase()))].join(", ")}`);
  const livr = (fullText.match(/livraison gratuite/gi) || []).length;
  if (livr > 1) issues.push(`« livraison gratuite » ${livr}× (max 1)`);
  if (art.meta_description.length > 155) issues.push(`méta-description ${art.meta_description.length} car. (>155)`);
  if (/!\[/.test(fullText)) issues.push("image markdown détectée (0 image exigée)");
  const linkHits = t.links.filter((l) => fullText.includes(l.url)).length;
  if (linkHits < 2) issues.push(`seulement ${linkHits} lien(s) interne(s) intégré(s) (2-3 exigés)`);
  if (!art.faq || art.faq.length < 4 || art.faq.length > 6) issues.push(`FAQ ${art.faq?.length ?? 0} Q/R (4-6 exigées)`);
  return issues;
}

function assemble(t, art) {
  const links = t.links.map((l) => `- [${l.title}](${l.url}) _(handle à vérifier)_`).join("\n");
  return `---
title: "${t.title.replace(/"/g, '\\"')}"
slug: ${t.slug}
category: ${t.category}
intention: ${t.intention}
meta_description: "${art.meta_description.replace(/"/g, '\\"')}"
status: draft
generated_by: ${MODEL}
dry_run: true
---

# ${t.title}

${art.intro.trim()}

${art.body_markdown.trim()}

## Foire aux questions

${art.faq.map((f) => `### ${f.question}\n\n${f.answer.trim()}`).join("\n\n")}

## Maillage interne

${links}

<script type="application/ld+json">
${faqJsonLd(art.faq)}
</script>
`;
}

async function generate(client, t) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    messages: [{ role: "user", content: buildPrompt(t) }],
  });
  const raw = res.content.find((b) => b.type === "text")?.text ?? "";
  const art = JSON.parse(stripFences(raw));
  const md = assemble(t, art);
  const issues = checks(t, art, md);
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${t.slug}.md`);
  writeFileSync(path, md, "utf8");
  const usage = res.usage;
  return { path, issues, meta: art.meta_description, metaLen: art.meta_description.length,
    faqCount: art.faq.length, tokens: `${usage.input_tokens}in/${usage.output_tokens}out` };
}

const arg = process.argv[2];
if (!process.env.ANTHROPIC_API_KEY) { console.error("ERROR: ANTHROPIC_API_KEY not set"); process.exit(1); }
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 3 });

let targets;
if (arg === "all") targets = TOPICS;
else if (/^\d+-\d+$/.test(arg)) { const [a, b] = arg.split("-").map(Number); targets = TOPICS.filter((t) => t.n >= a && t.n <= b); }
else targets = [TOPICS[Number(arg) - 1]].filter(Boolean);
if (!targets || targets.length === 0) { console.error(`Usage: node scripts/generate-seo-articles.mjs <1-${TOPICS.length}|N-M|all>`); process.exit(1); }

for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  process.stdout.write(`[${t.n}/${TOPICS.length}] ${t.slug} … `);
  try {
    const r = await generate(client, t);
    console.log(`OK (${r.tokens}, FAQ ${r.faqCount}, méta ${r.metaLen}c)`);
    console.log(`   → ${r.path}`);
    if (r.issues.length) console.log(`   ⚠ ${r.issues.join(" | ")}`); else console.log("   ✓ contraintes OK");
  } catch (e) {
    console.log(`ÉCHEC : ${e.message}`);
  }
  if (i < targets.length - 1) await new Promise((res) => setTimeout(res, RATE_LIMIT_MS));
}
