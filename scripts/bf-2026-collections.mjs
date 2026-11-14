#!/usr/bin/env node
/**
 * Black Friday 2026 (early launch 11-06, Fri 11-27, Cyber Monday 11-30) — the two collections Mat chose 2026-10-31:
 *   A  black-friday-gros-rabais   "Vendredi fou — nos plus gros rabais": genuine crossed price ≥ 15 %.
 *   B  black-friday-cadeaux-noel  "Idées cadeaux en rabais": A + Noël collections, toys, pets, décor ≥ 10 %.
 * No extra discount: only products whose current compare-at (a real former price, see the 10 % rule and
 * compare_at_min_days) is already above the price. Membership = product tags bf26-top-rabais / bf26-cadeaux,
 * so the smart collections follow the tags; re-run it during the month because prices move, and on 11-27 and 12-01 (text phase).
 * Collections are created UNPUBLISHED (not on the Online Store) — publish them at launch.
 * Handles contain "black-friday" so the breadcrumb (lc-structured-data) never uses them as a category.
 *   node-x64 --env-file=.env.local scripts/bf-2026-collections.mjs [--apply]
 */
import fs from "node:fs";
import { gql, loadEnv, sleep } from "./_shopify-lib.mjs";

loadEnv();
const APPLY = process.argv.includes("--apply");
const TAG_A = "bf26-top-rabais";
const TAG_B = "bf26-cadeaux";
const GIFT_TYPE = /^Toys & Games|^Pet Supplies|Decor|Christmas|Holiday|Seasonal/i;
const NOEL = ["noel", "noel-sapins", "noel-decorations"];

// Early launch Nov 6 (Mat, 2026-11-01): the price guarantee removes the "wait for the real Black Friday" objection.
// Its terms are binding as written (Quebec LPC) — keep them precise: window, same item, our own site price, claim deadline.
const GUARANTEE_FR = "<p><strong>Garantie de prix jusqu'au 30 novembre.</strong> Vous avez acheté un article chez nous entre le 6 et le 30 novembre 2026 et son prix baisse sur notre site avant le 30 novembre 2026 à 23 h 59 (heure de l'Est) ? Le remboursement n'est pas automatique : faites-en la demande en répondant au courriel de confirmation de votre commande, au plus tard le 7 décembre 2026. Nous vous remboursons alors l'écart entre le prix payé et le prix le plus bas affiché pendant cette période, sur votre mode de paiement d'origine. La garantie vise le même article (même modèle, même couleur et même format), compare le prix affiché sur notre site, hors taxes et frais, et ne s'applique pas aux articles retournés ni aux commandes annulées.</p>";
const GUARANTEE_EN = "<p><strong>Price guarantee until November 30.</strong> Bought an item from us between November 6 and November 30, 2026, and its price drops on our site before November 30, 2026, 11:59 p.m. (Eastern)? The refund is not automatic: claim it by replying to your order confirmation email by December 7, 2026, and we will refund the gap between the price you paid and the lowest price shown during that period, to your original payment method. The guarantee covers the identical item (same model, colour and size), compares the price shown on our site before taxes and fees, and does not apply to returned items or cancelled orders.</p>";
const SHIP_FR = "Livraison gratuite au Canada (sauf certaines régions éloignées).";
const SHIP_EN = "Free shipping in Canada (some remote areas excepted).";

// The collection text is not date-driven like the banner: the script picks it from today's Toronto date,
// so re-run it on Nov 27 and on Dec 1 (the guarantee text disappears after Nov 30).
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const PHASE = TODAY >= "2026-12-01" ? "after" : TODAY >= "2026-11-27" ? "bf" : "early";
const LEAD_A = {
  early: ["Le Vendredi fou est commencé : nos plus gros rabais de l'année, jusqu'à épuisement des stocks. Commandez tôt pour recevoir avant Noël.",
    "Black Friday starts now: our biggest deals of the year, while supplies last. Order early to receive before Christmas."],
  bf: ["Derniers jours du Vendredi fou : nos plus gros rabais de l'année, jusqu'à épuisement des stocks.",
    "Last days of Black Friday: our biggest deals of the year, while supplies last."],
  after: ["Nos plus gros rabais du moment, jusqu'à épuisement des stocks. Commandez d'ici le 7 décembre pour recevoir avant Noël.",
    "Our biggest deals right now, while supplies last. Order by December 7 to receive before Christmas."],
}[PHASE];
const LEAD_B = PHASE === "after"
  ? ["Des idées cadeaux pour toute la famille, et pour les animaux, à prix réduit. Commandez d'ici le 7 décembre pour recevoir avant Noël.",
    "Gift ideas for the whole family, pets included, at reduced prices. Order by December 7 to receive before Christmas."]
  : ["Des idées cadeaux pour toute la famille, et pour les animaux, à prix réduit. Commandez tôt pour recevoir avant Noël.",
    "Gift ideas for the whole family, pets included, at reduced prices. Order early to receive before Christmas."];
const bodyOf = (lead, ship, guarantee) => `<p>${lead} ${ship}</p>${PHASE === "after" ? "" : guarantee}`;

const COLLECTIONS = [
  {
    handle: "black-friday-gros-rabais", tag: TAG_A,
    title: "Vendredi fou — nos plus gros rabais", titleEn: "Black Friday — Our Biggest Deals",
    body: bodyOf(LEAD_A[0], SHIP_FR, GUARANTEE_FR), bodyEn: bodyOf(LEAD_A[1], SHIP_EN, GUARANTEE_EN),
  },
  {
    handle: "black-friday-cadeaux-noel", tag: TAG_B,
    title: "Idées cadeaux en rabais", titleEn: "Gift Ideas on Sale",
    body: bodyOf(LEAD_B[0], SHIP_FR, GUARANTEE_FR), bodyEn: bodyOf(LEAD_B[1], SHIP_EN, GUARANTEE_EN),
  },
];
// Shopify may re-encode the HTML it stores (entities, spaces): compare normalized text, not raw strings.
const norm = (s) => (s || "").replace(/&#39;|&apos;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;| /g, " ").replace(/\s+/g, " ").trim();

// 1. Noël collection members
const noel = new Set();
for (const h of NOEL) {
  let c = null;
  do {
    const r = (await gql(`query($h:String!,$c:String){collectionByHandle(handle:$h){products(first:250,after:$c){pageInfo{hasNextPage endCursor} nodes{id}}}}`, { h, c })).data.collectionByHandle?.products;
    if (!r) break;
    r.nodes.forEach((n) => noel.add(n.id));
    c = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  } while (c);
}

// 2. Live discounts on every active product (best genuine discount among available variants)
const plan = [];
let cursor = null, scanned = 0;
const count = { A: 0, B: 0 };
do {
  const r = (await gql(`query($c:String){products(first:100,after:$c,query:"status:active"){pageInfo{hasNextPage endCursor}
    nodes{id handle productType tags variants(first:50){nodes{price compareAtPrice availableForSale}}}}}`, { c: cursor })).data.products;
  for (const p of r.nodes) {
    scanned++;
    let best = 0;
    for (const v of p.variants.nodes) {
      const cp = Number(v.compareAtPrice), pr = Number(v.price);
      if (v.availableForSale && cp > pr) best = Math.max(best, 1 - pr / cp);
    }
    const inA = best >= 0.15;
    const inB = inA || (best >= 0.10 && (noel.has(p.id) || GIFT_TYPE.test(p.productType)));
    if (inA) count.A++;
    if (inB) count.B++;
    const add = [], remove = [];
    for (const [tag, want] of [[TAG_A, inA], [TAG_B, inB]]) {
      const has = p.tags.includes(tag);
      if (want && !has) add.push(tag);
      if (!want && has) remove.push(tag);
    }
    if (add.length || remove.length) plan.push({ id: p.id, handle: p.handle, pct: Math.round(best * 100), add, remove });
  }
  cursor = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  await sleep(300);
} while (cursor);

fs.mkdirSync(".context/bf-2026", { recursive: true });
fs.writeFileSync(".context/bf-2026/plan.json", JSON.stringify(plan, null, 1));
console.log(`phase ${PHASE} (${TODAY}) · scanned ${scanned} · A=${count.A} · B=${count.B} · tag changes on ${plan.length} products`);

// 3. Collections that already exist
const existing = {};
for (const c of COLLECTIONS) existing[c.handle] = (await gql(`query($h:String!){collectionByHandle(handle:$h){id title descriptionHtml}}`, { h: c.handle })).data.collectionByHandle;
for (const c of COLLECTIONS) {
  const e = existing[c.handle];
  console.log(`collection ${c.handle}: ${!e ? "to create (unpublished)" : norm(e.descriptionHtml) === norm(c.body) ? "exists, text up to date" : "exists, text to update (FR + EN)"}`);
}
if (!APPLY) {
  console.log("DRY-RUN — nothing written.");
  process.exit(0);
}

let errors = 0;
for (const x of plan) {
  if (x.add.length) {
    const e = (await gql(`mutation($id:ID!,$t:[String!]!){tagsAdd(id:$id,tags:$t){userErrors{message}}}`, { id: x.id, t: x.add })).data.tagsAdd.userErrors;
    if (e.length) { errors++; console.log("✘", x.handle, JSON.stringify(e)); }
  }
  if (x.remove.length) {
    const e = (await gql(`mutation($id:ID!,$t:[String!]!){tagsRemove(id:$id,tags:$t){userErrors{message}}}`, { id: x.id, t: x.remove })).data.tagsRemove.userErrors;
    if (e.length) { errors++; console.log("✘", x.handle, JSON.stringify(e)); }
  }
  await sleep(250);
}

async function registerEn(id, c) {
  const dig = Object.fromEntries((await gql(`query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest}}}`, { id })).data.translatableResource.translatableContent.map((x) => [x.key, x.digest]));
  const t = [{ key: "title", locale: "en", value: c.titleEn, translatableContentDigest: dig.title }];
  if (dig.body_html) t.push({ key: "body_html", locale: "en", value: c.bodyEn, translatableContentDigest: dig.body_html });
  const tr = (await gql(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){userErrors{message}}}`, { id, t })).data.translationsRegister;
  if (tr.userErrors.length) { errors++; console.log("✘ EN", c.handle, JSON.stringify(tr.userErrors)); }
}

for (const c of COLLECTIONS) {
  const ex = existing[c.handle];
  if (ex) {
    // Text changed since creation → update FR and re-register EN (the EN translation goes stale otherwise).
    // collectionUpdate does not touch publication: a hidden collection stays hidden.
    if (norm(ex.descriptionHtml) === norm(c.body)) continue;
    const e = (await gql(`mutation($i:CollectionInput!){collectionUpdate(input:$i){userErrors{field message}}}`, { i: { id: ex.id, descriptionHtml: c.body } })).data.collectionUpdate.userErrors;
    if (e.length) { errors++; console.log("✘ update", c.handle, JSON.stringify(e)); continue; }
    await registerEn(ex.id, c);
    console.log(`✔ updated text ${c.handle}`);
    continue;
  }
  const r = (await gql(`mutation($i:CollectionInput!){collectionCreate(input:$i){collection{id} userErrors{field message}}}`, {
    i: { handle: c.handle, title: c.title, descriptionHtml: c.body, sortOrder: "BEST_SELLING", ruleSet: { appliedDisjunctively: false, rules: [{ column: "TAG", relation: "EQUALS", condition: c.tag }] } },
  })).data.collectionCreate;
  if (r.userErrors.length) { errors++; console.log("✘ create", c.handle, JSON.stringify(r.userErrors)); continue; }
  await registerEn(r.collection.id, c);
  console.log(`✔ created ${c.handle} (${r.collection.id}), unpublished`);
}
console.log(`APPLIED — ${errors} error(s)`);
