// FIX 4B follow-up — register EN "Sale 🔥" for the new menu item via the LINK resource.
import { gql } from "./_shopify-lib.mjs";

const NUM = "615724089449"; // MenuItem numeric id from menuUpdate

// Try a few candidate resource types Shopify uses for navigation links.
const candidates = [
  `gid://shopify/Link/${NUM}`,
  `gid://shopify/MenuItem/${NUM}`,
  `gid://shopify/OnlineStoreMenuItem/${NUM}`,
];

let target = null, digest = null;
for (const id of candidates) {
  try {
    const tr = await gql(
      `query($id: ID!){ translatableResource(resourceId:$id){ resourceId translatableContent { key value digest locale } } }`,
      { id }
    );
    const r = tr.data.translatableResource;
    if (r && r.translatableContent && r.translatableContent.length) {
      const titleC = r.translatableContent.find((c) => c.key === "title");
      console.log(`✓ ${id} -> translatable keys: ${r.translatableContent.map((c) => c.key).join(", ")}`);
      if (titleC) { target = id; digest = titleC.digest; break; }
    } else {
      console.log(`  ${id} -> no translatable content`);
    }
  } catch (e) {
    console.log(`  ${id} -> ${e.message.split("\n")[0].slice(0, 80)}`);
  }
}

if (!target) {
  console.error("\nCould not resolve a translatable resource for the menu item. EN will fall back to FR ('Rabais 🔥').");
  process.exit(1);
}

const reg = await gql(
  `mutation($id: ID!, $t: [TranslationInput!]!) {
    translationsRegister(resourceId: $id, translations: $t) { translations{key value locale} userErrors { field message } }
  }`,
  { id: target, t: [{ key: "title", locale: "en", value: "Sale 🔥", translatableContentDigest: digest }] }
);
const ue = reg.data.translationsRegister.userErrors;
if (ue.length) { console.error("userErrors:", JSON.stringify(ue)); process.exit(1); }
console.log(`✓ EN menu translation registered on ${target}: "Sale 🔥"`);
