import { rest, gql } from "./_shopify-lib.mjs";

// 1) existing collections matching rabais/sale
const sc = await (await rest("/smart_collections.json?limit=250")).json();
const cc = await (await rest("/custom_collections.json?limit=250")).json();
const all = [
  ...(sc.smart_collections || []).map((c) => ({ ...c, kind: "smart" })),
  ...(cc.custom_collections || []).map((c) => ({ ...c, kind: "custom" })),
];
console.log("=== collections matching rabais/sale ===");
for (const c of all) {
  if (/rabais|sale|solde|promo/i.test(c.title + " " + c.handle)) {
    console.log(`  [${c.kind}] id=${c.id} handle=${c.handle} title="${c.title}"`);
  }
}
console.log(`  (total collections: ${all.length})`);

// 2) menus
const m = await gql(`{
  menus(first: 20) {
    nodes {
      id handle title
      items { id title url type resourceId items { id title url type } }
    }
  }
}`);
console.log("\n=== MENUS ===");
for (const menu of m.data.menus.nodes) {
  console.log(`\n# ${menu.title} (handle=${menu.handle}) id=${menu.id}`);
  for (const it of menu.items) {
    console.log(`  - "${it.title}" [${it.type}] ${it.url} ${it.resourceId || ""}`);
    for (const sub of it.items || []) console.log(`      • "${sub.title}" [${sub.type}] ${sub.url}`);
  }
}
