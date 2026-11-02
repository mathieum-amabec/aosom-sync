#!/usr/bin/env node
/**
 * Activates the Garantie Tranquillité (Mat's go 2026-11-02, after the lawyer's approval and PR #679 deployed).
 * Steps (each idempotent):
 *   1. product garantie-tranquillite-2-ans → ACTIVE, published to the Online Store ONLY
 *      (never to the Facebook & Instagram / Google & YouTube / Shop / POS channels: no ad catalogue).
 *   2. hidden collection rabais-2e-article: AND rule `TAG NOT_EQUALS internal-warranty`
 *      (the warranty must not get, nor trigger, the 10 % 2nd-item discount).
 *   3. page /pages/garantie-tranquillite → published.
 *   4. (--enable only) shop metafield custom.warranty_enabled = true → the PDP offer shows for everyone.
 *      Run --enable only after the storefront QA with ?lc_garantie=1.
 *
 *   node-x64 --env-file=.env.local scripts/activate-warranty.mjs                 # dry-run
 *   node-x64 --env-file=.env.local scripts/activate-warranty.mjs --apply         # steps 1-3
 *   node-x64 --env-file=.env.local scripts/activate-warranty.mjs --apply --enable  # + step 4
 *   node-x64 --env-file=.env.local scripts/activate-warranty.mjs --apply --disable # metafield false (kill switch)
 */
import { gql, rest, loadEnv } from "./_shopify-lib.mjs";

loadEnv();
const APPLY = process.argv.includes("--apply");
const ENABLE = process.argv.includes("--enable");
const DISABLE = process.argv.includes("--disable");
const PRODUCT_HANDLE = "garantie-tranquillite-2-ans";
const PAGE_HANDLE = "garantie-tranquillite";
const RABAIS = "gid://shopify/Collection/485596921961";
const RULE = { column: "TAG", relation: "NOT_EQUALS", condition: "internal-warranty" };

const q = async (query, variables) => {
  const r = await gql(query, variables);
  return r.data;
};

// 1. product
const { products } = await q(`query($q:String!){ products(first:1, query:$q){ nodes { id status productType tags
  resourcePublications(first: 10) { nodes { publication { id name } isPublished } } } } }`, { q: `handle:${PRODUCT_HANDLE}` });
const prod = products.nodes[0];
if (!prod || prod.productType !== "Garantie" || !prod.tags.includes("internal-warranty")) throw new Error("warranty product missing or not marked internal");
const { publications } = await q(`{ publications(first: 20) { nodes { id name } } }`);
const online = publications.nodes.find((p) => p.name === "Online Store");
const pubs = prod.resourcePublications.nodes.filter((n) => n.isPublished).map((n) => n.publication.name);
console.log(`product ${prod.id}: ${prod.status}, published on [${pubs.join(", ") || "none"}]`);

// 2. collection rule
const { collection } = await q(`query($id: ID!){ collection(id: $id){ title ruleSet { appliedDisjunctively rules { column relation condition } } } }`, { id: RABAIS });
const rules = collection.ruleSet.rules;
const hasRule = rules.some((r) => r.column === RULE.column && r.relation === RULE.relation && r.condition === RULE.condition);
console.log(`collection "${collection.title}": disjunctive=${collection.ruleSet.appliedDisjunctively} rules=${JSON.stringify(rules)} exclusion=${hasRule}`);
if (collection.ruleSet.appliedDisjunctively) throw new Error("rabais collection uses OR rules: an exclusion rule would not exclude — stop");

// 3. page
const page = (await (await rest(`/pages.json?handle=${PAGE_HANDLE}&fields=id,published_at`)).json()).pages?.[0];
if (!page) throw new Error("terms page missing");
console.log(`page ${page.id}: published_at=${page.published_at}`);

// 4. metafield
const { shop } = await q(`{ shop { id metafield(namespace: "custom", key: "warranty_enabled") { value type } } }`);
console.log(`shop metafield custom.warranty_enabled = ${shop.metafield?.value ?? "(unset)"}`);

if (!APPLY) { console.log("dry-run"); process.exit(0); }

if (!DISABLE) {
  if (prod.status !== "ACTIVE") {
    const r = await q(`mutation($p: ProductUpdateInput!){ productUpdate(product: $p){ product { status } userErrors { message } } }`, { p: { id: prod.id, status: "ACTIVE" } });
    if (r.productUpdate.userErrors.length) throw new Error(JSON.stringify(r.productUpdate.userErrors));
    console.log("✓ product ACTIVE");
  }
  if (!pubs.includes("Online Store")) {
    const r = await q(`mutation($id: ID!, $input: [PublicationInput!]!){ publishablePublish(id: $id, input: $input){ userErrors { message } } }`, { id: prod.id, input: [{ publicationId: online.id }] });
    if (r.publishablePublish.userErrors.length) throw new Error(JSON.stringify(r.publishablePublish.userErrors));
    console.log("✓ published to Online Store only");
  }
  if (!hasRule) {
    const r = await q(`mutation($c: CollectionInput!){ collectionUpdate(input: $c){ collection { ruleSet { rules { column relation condition } } } userErrors { message } } }`,
      { c: { id: RABAIS, ruleSet: { appliedDisjunctively: false, rules: [...rules, RULE] } } });
    if (r.collectionUpdate.userErrors.length) throw new Error(JSON.stringify(r.collectionUpdate.userErrors));
    console.log("✓ rabais rule added:", JSON.stringify(r.collectionUpdate.collection.ruleSet.rules));
  }
  if (!page.published_at) {
    const r = await rest(`/pages/${page.id}.json`, { method: "PUT", body: JSON.stringify({ page: { id: page.id, published: true } }) });
    if (!r.ok) throw new Error(`page publish ${r.status}`);
    console.log("✓ terms page published");
  }
}
if (ENABLE || DISABLE) {
  const r = await q(`mutation($m: [MetafieldsSetInput!]!){ metafieldsSet(metafields: $m){ metafields { value } userErrors { message } } }`,
    { m: [{ ownerId: shop.id, namespace: "custom", key: "warranty_enabled", type: "boolean", value: ENABLE ? "true" : "false" }] });
  if (r.metafieldsSet.userErrors.length) throw new Error(JSON.stringify(r.metafieldsSet.userErrors));
  console.log(`✓ custom.warranty_enabled = ${r.metafieldsSet.metafields[0].value}`);
}
