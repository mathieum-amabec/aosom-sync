// FIX 4A — create "Rabais" smart collection + EN "Sale" translation.
import { rest, gql } from "./_shopify-lib.mjs";

const DRY = process.argv.includes("--dry");

const payload = {
  smart_collection: {
    title: "Rabais",
    handle: "rabais",
    sort_order: "best-selling",
    disjunctive: true, // OR between rules
    published: true,
    rules: [
      { column: "variant_compare_at_price", relation: "greater_than", condition: "0" },
      { column: "tag", relation: "equals", condition: "sale" },
      { column: "tag", relation: "equals", condition: "rabais" },
    ],
  },
};

if (DRY) {
  console.log("[DRY] would POST /smart_collections.json:\n", JSON.stringify(payload, null, 2));
  process.exit(0);
}

const res = await rest("/smart_collections.json", {
  method: "POST",
  body: JSON.stringify(payload),
});
if (!res.ok) {
  console.error("CREATE FAILED", res.status, await res.text());
  process.exit(1);
}
const { smart_collection: col } = await res.json();
console.log(`✓ Created smart collection id=${col.id} handle=${col.handle} title="${col.title}"`);
console.log(`  products_count=${col.products_count} sort=${col.sort_order} disjunctive=${col.disjunctive}`);
console.log(`  rules:`, JSON.stringify(col.rules));

const gid = `gid://shopify/Collection/${col.id}`;

// --- EN translation "Sale" ---
const tr = await gql(
  `query($id: ID!){ translatableResource(resourceId:$id){ translatableContent { key value digest locale } } }`,
  { id: gid }
);
const titleContent = tr.data.translatableResource.translatableContent.find((c) => c.key === "title");
if (!titleContent) {
  console.error("No translatable 'title' content found; cannot register EN translation.");
  process.exit(1);
}
const reg = await gql(
  `mutation($id: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $id, translations: $translations) {
      translations { key value locale }
      userErrors { field message }
    }
  }`,
  {
    id: gid,
    translations: [
      { key: "title", locale: "en", value: "Sale", translatableContentDigest: titleContent.digest },
    ],
  }
);
const ue = reg.data.translationsRegister.userErrors;
if (ue.length) {
  console.error("translationsRegister userErrors:", JSON.stringify(ue));
  process.exit(1);
}
console.log(`✓ EN translation registered: title -> "Sale"`);
console.log(`\nNEW_COLLECTION_GID=${gid}`);
