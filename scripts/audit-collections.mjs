// Read-only: classify the 3 home-carousel collections (smart vs manual, rules,
// product count, whether sold-out filtering is even meaningful).
import { rest } from "./_shopify-lib.mjs";

const handles = ["rabais", "coups-de-coeur", "mobiliers-exterieurs-et-jardins"];

// Find collection id+type by handle across smart + custom collections.
const smart = (await (await rest("/smart_collections.json?limit=250")).json()).smart_collections || [];
const custom = (await (await rest("/custom_collections.json?limit=250")).json()).custom_collections || [];

for (const h of handles) {
  const sm = smart.find((c) => c.handle === h);
  const cu = custom.find((c) => c.handle === h);
  const col = sm || cu;
  if (!col) { console.log(`\n${h}: NOT FOUND in smart/custom collections`); continue; }
  const type = sm ? "SMART (automated)" : "CUSTOM (manual)";
  console.log(`\n=== ${h} === [${type}] id=${col.id} published=${!!col.published_at}`);
  if (sm) {
    console.log(`  disjunctive(any/all): ${sm.disjunctive ? "ANY" : "ALL"}`);
    console.log(`  rules: ${JSON.stringify(sm.rules)}`);
    console.log(`  sort_order: ${sm.sort_order}`);
  } else {
    console.log(`  sort_order: ${cu.sort_order}`);
  }
  const cnt = await (await rest(`/collections/${col.id}/products.json?limit=250&fields=id`)).json();
  console.log(`  products in collection: ${(cnt.products || []).length}`);
}
