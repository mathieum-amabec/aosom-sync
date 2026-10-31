#!/usr/bin/env node
/**
 * Hand fix of the 2 products whose French body was the raw English supplier text (with "Aosom"),
 * found by the 2026-10-31 SEO / AI-search audit. Also fixes their title dimensions (title said
 * 183x122 / 244 while the specs and handle say 192 x 127 / 240), the EN title's leading space, and the
 * greenhouse EN body's false "year-round, even during harsh winters" claim (the spec sheet says it is
 * NOT built for heavy snow). Handles are kept (URLs unchanged).
 *
 *   node-x64 --env-file=.env.local scripts/seo-audit-fix-two-products-2026-10-31.mjs           # dry-run
 *   node-x64 --env-file=.env.local scripts/seo-audit-fix-two-products-2026-10-31.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import { gql, loadEnv } from "./_shopify-lib.mjs";

loadEnv();
const APPLY = process.argv.includes("--apply");
const OUT = path.resolve(".context/seo-audit");
fs.mkdirSync(OUT, { recursive: true });

const FIXES = [
  {
    handle: "serre-adossee-aluminium-192x127cm-polycarbonate-gris-fonce",
    title: "Serre adossée en aluminium 192 x 127 cm, polycarbonate — Gris foncé",
    seoTitle: "Serre adossée aluminium 192 x 127 cm | Livraison gratuite — Ameublo",
    titleEn: "Lean-to Greenhouse, Aluminum, 192 x 127 cm, Polycarbonate — Dark Grey",
    body: `<p>Cette serre adossée se fixe contre un mur pour cultiver fleurs, légumes et fines herbes sans prendre trop de place. Son cadre en alliage d'aluminium forme une structure solide, et ses panneaux de polycarbonate traités anti-UV protègent vos plantes tout en laissant passer la lumière naturelle.</p>
<h3>Caractéristiques</h3>
<ul>
<li>Conception adossée au mur, idéale pour les petites cours et les côtés de maison</li>
<li>Cadre en alliage d'aluminium robuste, fait pour durer</li>
<li>Panneaux de polycarbonate avec protection UV</li>
<li>Porte coulissante pour entrer et sortir facilement</li>
<li>Fenêtre réglable sur 5 positions pour une bonne aération</li>
<li>Toit incliné avec gouttière pour éviter l'accumulation d'eau</li>
<li>Base galvanisée et 4 piquets d'ancrage inclus</li>
<li>Assemblage requis; le colis peut arriver en deux boîtes</li>
</ul>
<h3>Spécifications</h3>
<ul>
<li>Couleur : gris foncé et transparent</li>
<li>Matériaux : alliage d'aluminium, panneaux de polycarbonate</li>
<li>Dimensions hors tout : 192 x 127 x 214 cm (L x l x H)</li>
<li>Hauteur sous l'avant-toit : 134 cm</li>
<li>Porte : 62 x 158 cm (l x H)</li>
<li>Fenêtre : 57 x 60 cm (l x H)</li>
<li>Base : 190 x 127 x 12 cm</li>
<li>Longueur des piquets : 18 cm</li>
<li>Résistance au vent : niveau 4</li>
</ul>
<p><strong>À noter :</strong> cette serre n'est pas conçue pour supporter de fortes accumulations de neige. Installez-la contre un mur à l'abri du vent et fixez-la au sol avec des boulons d'ancrage pour plus de stabilité. Retirez la neige du toit en hiver.</p>
<h3>Contenu de la boîte</h3>
<ul>
<li>1 serre</li>
<li>1 base</li>
<li>1 guide d'assemblage</li>
</ul>`,
    // Only the false winter claim is replaced in the existing EN body; the rest stays.
    enBodyReplace: [
      [/Perfect for growing vegetables, herbs, and flowers all year round, even during our harsh winters\./, "Perfect for growing vegetables, herbs and flowers from spring to fall. Not built for heavy snow loads: place it against a sheltered wall and clear snow from the roof in winter."],
      [/Perfect for growing vegetables, herbs, and flowers year-round, even during harsh Canadian winters\./, "Perfect for growing vegetables, herbs and flowers from spring to fall. Not built for heavy snow loads: place it against a sheltered wall and clear snow from the roof in winter."],
      [/ - Resists Canadian weather conditions/, " - Solid, long-lasting structure"],
      [/ - Designed for the Canadian climate/, " - Stands up to moderate wind"],
      [/ - Engineered for Canadian climate/, " - Stands up to moderate wind"],
      [/ - Built to withstand Canadian weather conditions/, " - Solid, long-lasting structure"],
    ],
  },
  {
    handle: "bac-sureleve-galvanise-240x40x45cm-jardin-exterieur",
    title: "Bac surélevé galvanisé renforcé 240 x 40 x 45 cm",
    seoTitle: null,
    titleEn: "Galvanized Raised Garden Bed, Reinforced, 240 x 40 x 45 cm",
    body: `<p>Faites pousser légumes, fleurs et fines herbes dans ce bac surélevé en métal. Avec ses 45 cm de profondeur, il contient jusqu'à 394 litres de terre, assez pour les plantes à racines moyennes et profondes. L'acier galvanisé avec revêtement en poudre résiste à la rouille et aux intempéries, et le fond ouvert assure un excellent drainage.</p>
<h3>Caractéristiques</h3>
<ul>
<li>Profondeur de 45 cm pour légumes, fleurs et plantes d'extérieur</li>
<li>Cadre en acier galvanisé avec revêtement en poudre, durable</li>
<li>Barres de soutien intérieures et coins renforcés pour plus de stabilité</li>
<li>Fond ouvert qui favorise le drainage et la croissance des racines</li>
<li>Bords anti-coupure pour une manipulation sécuritaire</li>
<li>Assemblage facile (portez des gants pendant l'installation)</li>
</ul>
<h3>Spécifications</h3>
<ul>
<li>Matériau : acier galvanisé</li>
<li>Dimensions hors tout : 240 x 40 x 45 cm (L x l x H)</li>
<li>Dimensions intérieures : 237 x 37 x 45 cm</li>
<li>Capacité : environ 394 L de terre</li>
</ul>
<h3>Contenu de la boîte</h3>
<ul>
<li>1 bac surélevé</li>
<li>1 guide d'assemblage</li>
</ul>`,
    // Sold in 3 colours (grey, green, silver): drop the single-colour line; soften the weather claim.
    enBodyReplace: [
      [/<li>Elegant dark gr[ae]y colou?r complements any outdoor (setting|space)<\/li>\n?/, ""],
      [/designed to withstand Canadian elements/, "built to last outdoors"],
    ],
  },
];

const BRAND_RE = /\b(aosom|outsunny|homcom|pawhut|soozier|qaba|vinsetto|costway)\b/i;

const g = async (q, v) => {
  const r = await gql(q, v);
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  return r.data ?? r;
};

for (const f of FIXES) {
  for (const s of [f.title, f.seoTitle, f.titleEn, f.body]) if (s && BRAND_RE.test(s)) throw new Error(`supplier name in fix for ${f.handle}`);
  const d = await g(`query($h:String!){productByHandle(handle:$h){id title descriptionHtml seo{title description}
    mf:metafield(namespace:"custom",key:"title_en"){value}
    mfBody:metafield(namespace:"custom",key:"body_html_en"){value type}
    translations(locale:"en"){key value}
    es:translations(locale:"es"){key value} pa:translations(locale:"pa"){key value}}}`, { h: f.handle });
  const p = d.productByHandle;
  if (!p) throw new Error(`not found ${f.handle}`);
  const enBody = p.translations.find((t) => t.key === "body_html")?.value ?? "";
  let newEnBody = enBody;
  for (const [re, rep] of f.enBodyReplace) newEnBody = newEnBody.replace(re, rep);
  // The EN product page and the EN feed render custom.body_html_en, not the translation — fix both.
  const mfBodyEn = p.mfBody?.value ?? "";
  let newMfBodyEn = mfBodyEn;
  for (const [re, rep] of f.enBodyReplace) newMfBodyEn = newMfBodyEn.replace(re, rep);
  // es/pa translations were made from the old English-derived text (wrong dimensions): drop them so those
  // locales fall back to the corrected French until they are re-translated.
  const staleKeys = ["title", "body_html", "meta_title", "meta_description"];
  const staleLocales = ["es", "pa"].filter((l) => p[l].some((t) => staleKeys.includes(t.key)));
  const backup = { handle: f.handle, id: p.id, title: p.title, body: p.descriptionHtml, seo: p.seo, title_en_mf: p.mf?.value, body_html_en_mf: mfBodyEn, translations: p.translations, es: p.es, pa: p.pa };
  // Never overwrite: a dry-run after --apply would otherwise replace the true original with the fixed version.
  const bk = path.join(OUT, `backup-full-${f.handle}.json`);
  if (!fs.existsSync(bk)) fs.writeFileSync(bk, JSON.stringify(backup, null, 1));
  console.log(`\n${f.handle}\n  title: ${p.title}  →  ${f.title}\n  seoTitle: ${p.seo.title}  →  ${f.seoTitle ?? "(unchanged)"}\n  EN title → ${f.titleEn}\n  EN body changed: ${newEnBody !== enBody} · EN body metafield changed: ${newMfBodyEn !== mfBodyEn} · drop es/pa: ${staleLocales.join(",") || "none"}`);
  if (!APPLY) continue;

  const input = { id: p.id, title: f.title, descriptionHtml: f.body, metafields: [{ namespace: "custom", key: "title_en", type: "single_line_text_field", value: f.titleEn }] };
  if (newMfBodyEn !== mfBodyEn) input.metafields.push({ namespace: "custom", key: "body_html_en", type: p.mfBody.type, value: newMfBodyEn });
  if (f.seoTitle) input.seo = { title: f.seoTitle, description: p.seo.description };
  const u = await g(`mutation($p:ProductInput!){productUpdate(input:$p){userErrors{field message}}}`, { p: input });
  if (u.productUpdate.userErrors.length) throw new Error(JSON.stringify(u.productUpdate.userErrors));

  // Re-register EN title (+ body if changed) against the NEW French digests, else Shopify marks them outdated.
  const tr = await g(`query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest}}}`, { id: p.id });
  const dig = Object.fromEntries(tr.translatableResource.translatableContent.map((c) => [c.key, c.digest]));
  const t = [{ key: "title", locale: "en", value: f.titleEn, translatableContentDigest: dig.title }];
  if (enBody) t.push({ key: "body_html", locale: "en", value: newEnBody, translatableContentDigest: dig.body_html });
  const r = await g(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){userErrors{field message}}}`, { id: p.id, t });
  if (r.translationsRegister.userErrors.length) throw new Error(JSON.stringify(r.translationsRegister.userErrors));
  if (staleLocales.length) {
    const x = await g(`mutation($id:ID!,$k:[String!]!,$l:[String!]!){translationsRemove(resourceId:$id,translationKeys:$k,locales:$l){userErrors{field message}}}`, { id: p.id, k: staleKeys, l: staleLocales });
    if (x.translationsRemove.userErrors.length) throw new Error(JSON.stringify(x.translationsRemove.userErrors));
  }
  console.log("  ✔ applied");
}
if (!APPLY) console.log("\nDRY-RUN — nothing written (backups saved).");
