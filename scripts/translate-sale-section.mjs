import { gql, PREVIEW_THEME_ID } from "./_shopify-lib.mjs";

const gid = `gid://shopify/OnlineStoreTheme/${PREVIEW_THEME_ID}`;
const FR = "🔥 Meilleures offres du moment";
const EN = "🔥 Best deals right now";

const r = await gql(
  `query($id: ID!){ translatableResource(resourceId:$id){ translatableContent { key value digest } } }`,
  { id: gid }
);
const content = r.data.translatableResource.translatableContent || [];
const entry = content.find(
  (c) => c.key.startsWith("section.index.json.featured_sale.title") || c.value === FR
);
if (!entry) {
  console.error("Could not find translatable title for featured_sale. Keys with 'featured_sale':");
  content.filter((c) => c.key.includes("featured_sale")).forEach((c) => console.error("  " + c.key + " = " + JSON.stringify(c.value)));
  process.exit(1);
}
console.log(`Found: ${entry.key} = ${JSON.stringify(entry.value)}`);

const reg = await gql(
  `mutation($id: ID!, $t: [TranslationInput!]!) {
    translationsRegister(resourceId: $id, translations: $t) { translations{key locale value} userErrors { field message } }
  }`,
  { id: gid, t: [{ key: entry.key, locale: "en", value: EN, translatableContentDigest: entry.digest }] }
);
const ue = reg.data.translationsRegister.userErrors;
if (ue.length) { console.error("userErrors:", JSON.stringify(ue)); process.exit(1); }
console.log(`✓ EN title registered: "${EN}"`);
