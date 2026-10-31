#!/usr/bin/env node
/**
 * SEO / AI-search audit fixes (2026-10-31) — catalogue side.
 *
 *   node-x64 --env-file=.env.local scripts/seo-audit-fixes-2026-10-31.mjs            # dry-run (default)
 *   node-x64 --env-file=.env.local scripts/seo-audit-fixes-2026-10-31.mjs --apply    # write
 *   --only=tags,alt,seo,contact   restrict to some fixes
 *
 * Fixes (active products only):
 *  - tags:    drop/strip supplier brand names from product tags (no smart collection uses them).
 *  - alt:     fill EMPTY image alt text with the French product title ("… — photo N" after the first).
 *             Existing alt text is never touched.
 *  - seo:     fill an EMPTY SEO meta description: custom.meta_description_fr when present (generated at
 *             import but sometimes never applied), else a clean sentence cut from the French body.
 *             The EN translation (meta_description) is registered from custom.meta_description_en when
 *             present and no EN translation exists yet.
 *  - contact: add the phone number to the Shopify contact-information policy (agents read it via MCP).
 *
 * Dry-run writes the plan + a backup of every touched value to .context/seo-audit/ (gitignored).
 * Also prints a report of FR bodies that look English (not fixed automatically).
 */
import fs from "node:fs";
import path from "node:path";
import { gql, loadEnv, sleep } from "./_shopify-lib.mjs";

loadEnv();
const APPLY = process.argv.includes("--apply");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = new Set((onlyArg ? onlyArg.slice(7) : "tags,alt,seo,contact").split(","));
const OUT = path.resolve(".context/seo-audit");
fs.mkdirSync(OUT, { recursive: true });

// Same list as src/lib/catalog-guard.ts SUPPLIER_BRANDS.
const SUPPLIER_BRANDS = ["Outsunny", "HOMCOM", "Aosom", "Vinsetto", "PawHut", "Soozier", "Qaba", "ShopEZ", "Wikinger", "Portland", "Aousthop", "DuraHand", "Costway"];
const BRAND_RE = new RegExp(`\\b(?:${SUPPLIER_BRANDS.join("|")})\\b`, "gi");
const PHONE = "514-292-7788";

const g = async (query, variables) => {
  const r = await gql(query, variables);
  const d = r.data ?? r;
  if (r.errors) throw new Error(JSON.stringify(r.errors).slice(0, 500));
  return d;
};

function cleanTags(tags) {
  const out = [];
  for (const t of tags) {
    const s = t.replace(BRAND_RE, " ").replace(/\s+/g, " ").trim();
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

const decode = (s) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/&[a-z]+;/g, " ");

/** First sentences of the body, cut on a sentence/word boundary at ≤ 155 chars. */
export function descFromBody(html) {
  const text = decode(String(html || "").replace(/<(h\d|li)[^>]*>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/[•▪]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 60) return "";
  const max = 155;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (lastStop >= 80) return cut.slice(0, lastStop + 1);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[\s,;:–—-]+$/u, "") + "…";
}

const EN_WORDS = /\b(the|and|with|for|your|this|is|are|of|to)\b/gi;
const FR_WORDS = /\b(le|la|les|et|avec|pour|votre|vos|des|est|une|du)\b/gi;
function looksEnglish(html) {
  const t = String(html || "").replace(/<[^>]+>/g, " ");
  const en = (t.match(EN_WORDS) || []).length;
  const fr = (t.match(FR_WORDS) || []).length;
  return en >= 15 && en > fr * 2;
}

const Q = `query($a:String){products(first:60,after:$a,query:"status:active"){pageInfo{hasNextPage endCursor}
  nodes{id handle title tags descriptionHtml seo{description}
    mfr:metafield(namespace:"custom",key:"meta_description_fr"){value}
    men:metafield(namespace:"custom",key:"meta_description_en"){value}
    media(first:40){nodes{id alt mediaContentType}}}}}`;

const plan = { tags: [], alt: [], seo: [], seoEn: [], english: [] };
let after = null;
let n = 0;
do {
  const d = await g(Q, { a: after });
  for (const p of d.products.nodes) {
    n++;
    const title = p.title.replace(/\s+/g, " ").trim();
    if (ONLY.has("tags")) {
      const next = cleanTags(p.tags);
      if (next.length !== p.tags.length || next.some((t, i) => t !== p.tags[i])) plan.tags.push({ id: p.id, handle: p.handle, before: p.tags, after: next });
    }
    if (ONLY.has("alt")) {
      const imgs = p.media.nodes.filter((m) => m.mediaContentType === "IMAGE");
      const updates = [];
      imgs.forEach((m, i) => {
        if (!m.alt || !m.alt.trim()) updates.push({ id: m.id, alt: (i === 0 ? title : `${title} — photo ${i + 1}`).slice(0, 512) });
      });
      if (updates.length) plan.alt.push({ id: p.id, handle: p.handle, media: updates });
    }
    if (ONLY.has("seo") && !(p.seo.description || "").trim()) {
      const fromMf = (p.mfr?.value || "").replace(BRAND_RE, " ").replace(/\s+/g, " ").trim();
      let desc = fromMf && fromMf.length >= 60 && fromMf.length <= 170 ? fromMf : descFromBody(p.descriptionHtml.replace(BRAND_RE, " "));
      const SHIP = " Livraison gratuite partout au Canada.";
      if (desc && desc !== fromMf && !desc.endsWith("…") && desc.length + SHIP.length <= 160) desc += SHIP;
      if (desc && !looksEnglish(desc)) plan.seo.push({ id: p.id, handle: p.handle, source: desc === fromMf ? "metafield" : "body", value: desc });
      const en = (p.men?.value || "").replace(BRAND_RE, " ").replace(/\s+/g, " ").trim();
      if (en.length >= 60 && en.length <= 170) plan.seoEn.push({ id: p.id, handle: p.handle, value: en });
    }
    if (looksEnglish(p.descriptionHtml)) plan.english.push({ id: p.id, handle: p.handle, title });
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  await sleep(300);
} while (after);

const stamp = APPLY ? "apply" : "dryrun";
fs.writeFileSync(path.join(OUT, `plan-${stamp}.json`), JSON.stringify(plan, null, 1));
console.log(`scanned ${n} active products`);
console.log(`tags: ${plan.tags.length} products · alt: ${plan.alt.length} products / ${plan.alt.reduce((s, p) => s + p.media.length, 0)} images · seo FR: ${plan.seo.length} (metafield ${plan.seo.filter((s) => s.source === "metafield").length}) · seo EN candidates: ${plan.seoEn.length}`);
console.log(`FR bodies that look English (report only): ${plan.english.length}`, plan.english.slice(0, 20).map((e) => e.handle));

if (!APPLY) {
  console.log(`\nDRY-RUN — nothing written. Plan: ${path.join(OUT, `plan-${stamp}.json`)}`);
  process.exit(0);
}

const log = fs.createWriteStream(path.join(OUT, `applied-${Date.now()}.jsonl`), { flags: "a" });
const done = (o) => log.write(JSON.stringify(o) + "\n");

for (const t of plan.tags) {
  const r = await g(`mutation($p:ProductInput!){productUpdate(input:$p){userErrors{field message}}}`, { p: { id: t.id, tags: t.after } });
  done({ kind: "tags", id: t.id, before: t.before, after: t.after, errors: r.productUpdate.userErrors });
  await sleep(500);
}
for (const a of plan.alt) {
  const r = await g(`mutation($pid:ID!,$m:[UpdateMediaInput!]!){productUpdateMedia(productId:$pid,media:$m){mediaUserErrors{field message}}}`, { pid: a.id, m: a.media.map((x) => ({ id: x.id, alt: x.alt })) });
  done({ kind: "alt", id: a.id, media: a.media, errors: r.productUpdateMedia.mediaUserErrors });
  await sleep(500);
}
for (const s of plan.seo) {
  const r = await g(`mutation($p:ProductInput!){productUpdate(input:$p){userErrors{field message}}}`, { p: { id: s.id, seo: { description: s.value } } });
  done({ kind: "seo", id: s.id, before: "", after: s.value, errors: r.productUpdate.userErrors });
  await sleep(500);
}
// EN meta description: register only where no EN translation exists, against the NEW FR digest.
for (const s of plan.seoEn) {
  const d = await g(`query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest} translations(locale:"en"){key}}}`, { id: s.id });
  const tr = d.translatableResource;
  if (tr.translations.some((x) => x.key === "meta_description")) continue;
  const src = tr.translatableContent.find((c) => c.key === "meta_description");
  if (!src?.digest) continue;
  const r = await g(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){userErrors{field message}}}`, {
    id: s.id,
    t: [{ key: "meta_description", locale: "en", value: s.value, translatableContentDigest: src.digest }],
  });
  done({ kind: "seoEn", id: s.id, after: s.value, errors: r.translationsRegister.userErrors });
  await sleep(500);
}
if (ONLY.has("contact")) {
  const d = await g(`{shop{shopPolicies{type body}}}`);
  const pol = d.shop.shopPolicies.find((p) => p.type === "CONTACT_INFORMATION");
  if (pol && !pol.body.includes(PHONE)) {
    fs.writeFileSync(path.join(OUT, "contact-policy-before.html"), pol.body);
    const body = pol.body.replace(/(<\/p>\s*)?$/, (m) => `${m}<p>Téléphone / Phone : ${PHONE}</p>`);
    const r = await g(`mutation($p:ShopPolicyInput!){shopPolicyUpdate(shopPolicy:$p){userErrors{field message}}}`, { p: { type: "CONTACT_INFORMATION", body } });
    done({ kind: "contact", errors: r.shopPolicyUpdate.userErrors });
  }
}
log.end();
console.log("APPLIED — log in", OUT);
