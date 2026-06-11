// C1 — create the "Enfants et famille" smart collection (store-wide; Mat-authorized).
// Idempotent: skips if a collection with handle "enfants" already exists.
import { rest, gql, sleep } from "./_shopify-lib.mjs";

const HANDLE = "enfants";

// already exists?
const existing = await gql(`{ collections(first:250){ nodes{ id handle title } } }`);
const found = existing.data.collections.nodes.find((c) => c.handle === HANDLE);
if (found) {
  console.log(`• collection "${HANDLE}" already exists (${found.id}) — skipping create`);
} else {
  const body = {
    smart_collection: {
      title: "Enfants et famille",
      handle: HANDLE,
      rules: [
        { column: "type", relation: "contains", condition: "Kid" },
        { column: "type", relation: "contains", condition: "Child" },
        { column: "type", relation: "contains", condition: "Baby" },
        { column: "type", relation: "contains", condition: "Toy" },
        { column: "title", relation: "contains", condition: "enfant" },
        { column: "title", relation: "contains", condition: "jouet" },
      ],
      disjunctive: true,
      published: true,
    },
  };
  const res = await rest("/smart_collections.json", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const { smart_collection } = await res.json();
  console.log(`✔ created smart_collection "${smart_collection.title}" id=${smart_collection.id} handle=${smart_collection.handle} published=${!!smart_collection.published_at}`);
}

// confirm product count (smart collections populate async — poll briefly)
const cgid = `gid://shopify/Collection/${found ? found.id.split("/").pop() : ""}`;
let count = null;
for (let i = 0; i < 6; i++) {
  const q = await gql(`{ collectionByHandle(handle:"${HANDLE}"){ id title productsCount{count} } }`);
  const c = q.data.collectionByHandle;
  if (c) { count = c.productsCount.count; console.log(`   produits: ${count}` + (count > 0 ? "" : " (peut encore se peupler…)")); if (count > 0) break; }
  await sleep(2000);
}
console.log(`\nFait. Collection "Enfants et famille" (/collections/${HANDLE}) — ${count} produits.`);
