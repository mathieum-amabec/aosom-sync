#!/usr/bin/env node
/**
 * Black Friday 2026 (Fri 11-27, Cyber Monday 11-30) — the two collections Mat chose 2026-10-31:
 *   A  black-friday-gros-rabais   "Vendredi fou — nos plus gros rabais": genuine crossed price ≥ 15 %.
 *   B  black-friday-cadeaux-noel  "Idées cadeaux en rabais": A + Noël collections, toys, pets, décor ≥ 10 %.
 * No extra discount: only products whose current compare-at (a real former price, see the 10 % rule and
 * compare_at_min_days) is already above the price. Membership = product tags bf26-top-rabais / bf26-cadeaux,
 * so the smart collections follow the tags; re-run this script daily during BF week because prices move.
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

const COLLECTIONS = [
  {
    handle: "black-friday-gros-rabais", tag: TAG_A,
    title: "Vendredi fou — nos plus gros rabais", titleEn: "Black Friday — Our Biggest Deals",
    body: "<p>Nos plus gros rabais de l'année, jusqu'à épuisement des stocks. Livraison gratuite partout au Canada.</p>",
    bodyEn: "<p>Our biggest deals of the year, while supplies last. Free shipping across Canada.</p>",
  },
  {
    handle: "black-friday-cadeaux-noel", tag: TAG_B,
    title: "Idées cadeaux en rabais", titleEn: "Gift Ideas on Sale",
    body: "<p>Des idées cadeaux pour toute la famille, et pour les animaux, à prix réduit. Commandez tôt pour recevoir avant Noël. Livraison gratuite partout au Canada.</p>",
    bodyEn: "<p>Gift ideas for the whole family, pets included, at reduced prices. Order early to receive before Christmas. Free shipping across Canada.</p>",
  },
];

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
console.log(`scanned ${scanned} · A=${count.A} · B=${count.B} · tag changes on ${plan.length} products`);

// 3. Collections that already exist
const existing = {};
for (const c of COLLECTIONS) existing[c.handle] = (await gql(`query($h:String!){collectionByHandle(handle:$h){id title}}`, { h: c.handle })).data.collectionByHandle;
for (const c of COLLECTIONS) console.log(`collection ${c.handle}: ${existing[c.handle] ? "exists" : "to create (unpublished)"}`);
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

for (const c of COLLECTIONS) {
  if (existing[c.handle]) continue;
  const r = (await gql(`mutation($i:CollectionInput!){collectionCreate(input:$i){collection{id} userErrors{field message}}}`, {
    i: { handle: c.handle, title: c.title, descriptionHtml: c.body, sortOrder: "BEST_SELLING", ruleSet: { appliedDisjunctively: false, rules: [{ column: "TAG", relation: "EQUALS", condition: c.tag }] } },
  })).data.collectionCreate;
  if (r.userErrors.length) { errors++; console.log("✘ create", c.handle, JSON.stringify(r.userErrors)); continue; }
  const id = r.collection.id;
  const dig = Object.fromEntries((await gql(`query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest}}}`, { id })).data.translatableResource.translatableContent.map((x) => [x.key, x.digest]));
  const t = [{ key: "title", locale: "en", value: c.titleEn, translatableContentDigest: dig.title }];
  if (dig.body_html) t.push({ key: "body_html", locale: "en", value: c.bodyEn, translatableContentDigest: dig.body_html });
  const tr = (await gql(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){userErrors{message}}}`, { id, t })).data.translationsRegister;
  if (tr.userErrors.length) { errors++; console.log("✘ EN", c.handle, JSON.stringify(tr.userErrors)); }
  console.log(`✔ created ${c.handle} (${id}), unpublished`);
}
console.log(`APPLIED — ${errors} error(s)`);
