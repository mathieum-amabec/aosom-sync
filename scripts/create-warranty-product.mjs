#!/usr/bin/env node
/**
 * Creates the internal "Garantie Tranquillité 2 ans" product (docs/garantie-tranquillite-2-ans.md) as a DRAFT.
 * One variant per 10 $ price bracket (option "Palier" = bracket upper bound in dollars), price = 10 % of it.
 * Not shipped, not tracked, taxable, hidden from storefront search/sitemap (seo.hidden), tagged
 * internal-warranty + product_type "Garantie" so every automation skips it (src/lib/internal-product.ts).
 *
 *   node-x64 --env-file=.env.local scripts/create-warranty-product.mjs            # dry-run
 *   node-x64 --env-file=.env.local scripts/create-warranty-product.mjs --apply    # create as DRAFT
 * Activation (status ACTIVE + Online Store publication) is a separate, later step after the lawyer's OK.
 */
import { gql, loadEnv } from "./_shopify-lib.mjs";

loadEnv();
const APPLY = process.argv.includes("--apply");
const HANDLE = "garantie-tranquillite-2-ans";
const STEP = 10;
const MAX = 2000;

const brackets = [];
for (let b = STEP; b <= MAX; b += STEP) brackets.push(b);

const existing = await gql(`query($q:String!){ products(first:1, query:$q){ nodes { id status } } }`, { q: `handle:${HANDLE}` });
if (existing.data.products.nodes.length) {
  console.log(`already exists: ${existing.data.products.nodes[0].id} (${existing.data.products.nodes[0].status}) — nothing to do`);
  process.exit(0);
}

const input = {
  title: "Garantie Tranquillité 2 ans",
  handle: HANDLE,
  status: "DRAFT",
  vendor: "Ameublo Direct",
  productType: "Garantie",
  tags: ["internal-warranty"],
  descriptionHtml:
    "<p>Garantie supplémentaire de 24 mois offerte par Ameublo Direct : réparation ou remplacement sans débat, pièces expédiées gratuitement, aucuns frais de retour pour une réclamation couverte. Elle s'ajoute à la garantie légale et à la garantie Ameublo de 1 an. Détails : /pages/garantie-tranquillite</p>",
  productOptions: [{ name: "Palier", values: brackets.map((b) => ({ name: String(b) })) }],
  metafields: [{ namespace: "seo", key: "hidden", type: "number_integer", value: "1" }],
  variants: brackets.map((b) => ({
    optionValues: [{ optionName: "Palier", name: String(b) }],
    price: (b * 0.1).toFixed(2),
    sku: `AMEUBLO-GARANTIE-2A-${String(b).padStart(4, "0")}`,
    taxable: true,
    inventoryPolicy: "CONTINUE",
    inventoryItem: { tracked: false, requiresShipping: false },
  })),
};

console.log(`${brackets.length} variants: ${input.variants[0].sku} ${input.variants[0].price} $ … ${input.variants.at(-1).sku} ${input.variants.at(-1).price} $`);
if (!APPLY) {
  console.log("dry-run — re-run with --apply to create the DRAFT product");
  process.exit(0);
}

const r = await gql(
  `mutation($input: ProductSetInput!) { productSet(synchronous: true, input: $input) {
     product { id handle status variantsCount { count } }
     userErrors { field message code } } }`,
  { input },
);
if (r.data.productSet.userErrors.length) {
  console.error(JSON.stringify(r.data.productSet.userErrors, null, 2));
  process.exit(1);
}
console.log("created:", JSON.stringify(r.data.productSet.product));
