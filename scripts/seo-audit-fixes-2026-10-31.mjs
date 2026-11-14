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

// GraphQL throttling comes back as HTTP 200 + errors[].extensions.code THROTTLED (gql() throws) — back off and retry.
const g = async (query, variables, attempt = 0) => {
  try {
    const r = await gql(query, variables);
    return r.data ?? r;
  } catch (err) {
    if (attempt < 6 && /THROTTLED/.test(String(err))) {
      await sleep(2000 * (attempt + 1));
      return g(query, variables, attempt + 1);
    }
    throw err;
  }
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
const SHIP = " Livraison gratuite partout au Canada.";
const MAX = 160;

/** French typography the generated copy gets wrong: space before ":", unit glued to the number, "cet étagère". */
export function frTypo(s) {
  return s
    .replace(/([A-Za-zÀ-ÿ0-9)])\s?:\s/g, "$1 : ")
    .replace(/(\d)(cm|mm|po|kg|L)\b/g, "$1 $2")
    .replace(/\bcet étagère/gi, "cette étagère")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Meta description from the French body: whole sentences only (never cut mid-sentence), headings dropped,
 * and the product named — a hook sentence that never says what the product is ("La journée de travail…")
 * is prefixed with the title. Falls back to "<title>." + shipping line.
 */
export function descFromBody(html, title) {
  const text = decode(String(html || "").replace(/<h\d[^>]*>[\s\S]*?<\/h\d>/gi, " ").replace(/<li[^>]*>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/[•▪]/g, " ").replace(/\s+/g, " ").trim();
  const sentences = text.match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()) ?? [];
  const noun = (title.split(/\s+/)[0] || "").toLowerCase();
  let out = "";
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > MAX - SHIP.length) break;
    out = next;
  }
  if (out && noun && !out.toLowerCase().includes(noun)) {
    const withTitle = `${title.replace(/[.\s]+$/, "")}. ${out}`;
    out = withTitle.length <= MAX - SHIP.length ? withTitle : "";
  }
  if (out.length < 60) out = `${title.replace(/[.\s]+$/, "")}.`;
  return frTypo(out + SHIP);
}

/** Claims the products can't back (greenhouses aren't built for snow — see the 2026-10-31 serre fix). */
const SEASON_CLAIM = /(4|quatre) saisons|toute l['’]ann[ée]e|year[- ]round|all year|four[- ]season|winter protection/i;

const EN_WORDS = /\b(the|and|with|for|your|this|is|are|of|to)\b/gi;
const FR_WORDS = /\b(le|la|les|et|avec|pour|votre|vos|des|est|une|du)\b/gi;
function looksEnglish(html) {
  const t = String(html || "").replace(/<[^>]+>/g, " ");
  const en = (t.match(EN_WORDS) || []).length;
  const fr = (t.match(FR_WORDS) || []).length;
  return en >= 15 && en > fr * 2;
}

const Q = `query($a:String){products(first:25,after:$a,query:"status:active"){pageInfo{hasNextPage endCursor}
  nodes{id handle title tags descriptionHtml seo{title description}
    mfr:metafield(namespace:"custom",key:"meta_description_fr"){value}
    men:metafield(namespace:"custom",key:"meta_description_en"){value}
    media(first:100){nodes{id alt mediaContentType}}}}}`;

const plan = { tags: [], alt: [], seo: [], english: [] };
let after = null;
let n = 0;
do {
  const d = await g(Q, { a: after });
  for (const p of d.products.nodes) {
    n++;
    const title = p.title.replace(/\s+/g, " ").trim();
    if (ONLY.has("tags")) {
      const next = cleanTags(p.tags);
      const remove = p.tags.filter((t) => !next.includes(t));
      const add = next.filter((t) => !p.tags.includes(t));
      if (remove.length) plan.tags.push({ id: p.id, handle: p.handle, remove, add });
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
      const mfOk = fromMf.length >= 60 && fromMf.length <= MAX && /[.!?]$/.test(fromMf) && !SEASON_CLAIM.test(fromMf);
      let desc = mfOk ? frTypo(fromMf) : descFromBody(p.descriptionHtml.replace(BRAND_RE, " "), title);
      if (SEASON_CLAIM.test(desc)) desc = frTypo(`${title.replace(/[.\s]+$/, "")}.${SHIP}`);
      // EN: the stored metafield is sometimes already truncated mid-word — keep whole sentences only.
      let en = (p.men?.value || "").replace(BRAND_RE, " ").replace(/\s+/g, " ").trim();
      if (!/[.!?]$/.test(en)) en = (en.match(/^.*[.!?]/)?.[0] ?? "").trim();
      if (!(en.length >= 60 && en.length <= MAX && !SEASON_CLAIM.test(en))) en = "";
      if (desc) plan.seo.push({ id: p.id, handle: p.handle, source: mfOk ? "metafield" : "body", seoTitle: p.seo.title, value: desc, en });
    }
    if (looksEnglish(p.descriptionHtml)) plan.english.push({ id: p.id, handle: p.handle, title });
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  await sleep(300);
} while (after);

const stamp = APPLY ? "apply" : "dryrun";
fs.writeFileSync(path.join(OUT, `plan-${stamp}.json`), JSON.stringify(plan, null, 1));
console.log(`scanned ${n} active products`);
console.log(`tags: ${plan.tags.length} products · alt: ${plan.alt.length} products / ${plan.alt.reduce((s, p) => s + p.media.length, 0)} images · seo FR: ${plan.seo.length} (metafield ${plan.seo.filter((s) => s.source === "metafield").length}) · EN fallback values: ${plan.seo.filter((x) => x.en).length}`);
console.log(`FR bodies that look English (report only): ${plan.english.length}`, plan.english.slice(0, 20).map((e) => e.handle));

if (!APPLY) {
  console.log(`\nDRY-RUN — nothing written. Plan: ${path.join(OUT, `plan-${stamp}.json`)}`);
  process.exit(0);
}

const log = fs.createWriteStream(path.join(OUT, `applied-${Date.now()}.jsonl`), { flags: "a" });
const done = (o) => log.write(JSON.stringify(o) + "\n");

let errorCount = 0;
const check = (kind, id, errs) => { if (errs?.length) { errorCount++; console.error(kind, id, JSON.stringify(errs)); } return errs; };

// tagsRemove only touches the brand tags (a full tags list from the scan could revert a tag added since).
for (const t of plan.tags) {
  const r = await g(`mutation($id:ID!,$t:[String!]!){tagsRemove(id:$id,tags:$t){userErrors{field message}}}`, { id: t.id, t: t.remove });
  check("tags", t.id, r.tagsRemove.userErrors);
  if (t.add.length) {
    const a = await g(`mutation($id:ID!,$t:[String!]!){tagsAdd(id:$id,tags:$t){userErrors{field message}}}`, { id: t.id, t: t.add });
    check("tagsAdd", t.id, a.tagsAdd.userErrors);
  }
  done({ kind: "tags", id: t.id, removed: t.remove, added: t.add });
  await sleep(500);
}
for (const a of plan.alt) {
  const r = await g(`mutation($pid:ID!,$m:[UpdateMediaInput!]!){productUpdateMedia(productId:$pid,media:$m){mediaUserErrors{field message}}}`, { pid: a.id, m: a.media.map((x) => ({ id: x.id, alt: x.alt })) });
  done({ kind: "alt", id: a.id, media: a.media, errors: check("alt", a.id, r.productUpdateMedia.mediaUserErrors) });
  await sleep(500);
}
// FR description and its EN translation in the same pass, so an interrupted run never strands the EN step.
// seo.title is sent back unchanged: SEOInput is not merged field by field.
for (const s of plan.seo) {
  const r = await g(`mutation($p:ProductInput!){productUpdate(input:$p){product{seo{title description}} userErrors{field message}}}`, {
    p: { id: s.id, seo: { title: s.seoTitle, description: s.value } },
  });
  done({ kind: "seo", id: s.id, after: s.value, errors: check("seo", s.id, r.productUpdate.userErrors) });
  if (!r.productUpdate.userErrors.length && (r.productUpdate.product.seo.title ?? null) !== (s.seoTitle ?? null)) throw new Error(`seo.title changed on ${s.id} — stopping`);
  const d = await g(`query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest} translations(locale:"en"){key value}}}`, { id: s.id });
  const tr = d.translatableResource;
  const src = tr.translatableContent.find((c) => c.key === "meta_description");
  // Keep an existing EN translation (re-registered so it isn't flagged outdated); else use the EN metafield.
  const value = tr.translations.find((x) => x.key === "meta_description")?.value || s.en;
  if (src?.digest && value) {
    const t = await g(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){userErrors{field message}}}`, {
      id: s.id,
      t: [{ key: "meta_description", locale: "en", value, translatableContentDigest: src.digest }],
    });
    done({ kind: "seoEn", id: s.id, after: value, errors: check("seoEn", s.id, t.translationsRegister.userErrors) });
  }
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
console.log(`APPLIED — ${errorCount} item(s) with userErrors — log in`, OUT);
