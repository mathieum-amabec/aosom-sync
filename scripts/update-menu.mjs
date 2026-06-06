// FIX 4B — prepend "Rabais 🔥" / EN "Sale 🔥" to the main menu.
// Rebuilds the full menu (menuUpdate replaces all items) preserving existing structure.
import { rest, gql } from "./_shopify-lib.mjs";

const DRY = process.argv.includes("--dry");
const MENU_ID = "gid://shopify/Menu/221341417577"; // main-menu
const NEW_COLLECTION_GID = "gid://shopify/Collection/473544622185"; // Rabais

// product count sanity check
const colRes = await rest("/smart_collections/473544622185.json");
if (colRes.ok) {
  const c = (await colRes.json()).smart_collection;
  console.log(`Rabais collection products_count=${c.products_count} published=${c.published_at ? "yes" : "no"}\n`);
}

// fetch current menu with full nested fields
const cur = await gql(
  `query($id: ID!) {
    menu(id: $id) {
      id title handle
      items {
        id title type url resourceId tags
        items { id title type url resourceId tags
          items { id title type url resourceId tags }
        }
      }
    }
  }`,
  { id: MENU_ID }
);
const menu = cur.data.menu;

const stripLocale = (u) => (u ? u.replace(/^\/en(?=\/|$)/, "") || "/" : u);
function toInput(it) {
  const node = { title: it.title, type: it.type };
  const url = stripLocale(it.url);
  if (url) node.url = url;
  if (it.resourceId) node.resourceId = it.resourceId;
  if (it.tags && it.tags.length) node.tags = it.tags;
  if (it.items && it.items.length) node.items = it.items.map(toInput);
  return node;
}

const existing = menu.items.map(toInput);
const newItem = {
  title: "Rabais 🔥",
  type: "COLLECTION",
  resourceId: NEW_COLLECTION_GID,
  url: "/collections/rabais",
};
const items = [newItem, ...existing]; // FIRST item for max visibility

console.log("=== NEW MENU ITEM ORDER ===");
items.forEach((it, i) => console.log(`  ${i}. "${it.title}" [${it.type}]${it.items ? " (+" + it.items.length + " sub)" : ""}`));

if (DRY) {
  console.log("\n[DRY] menuUpdate payload:\n", JSON.stringify({ id: MENU_ID, title: menu.title, handle: menu.handle, items }, null, 2));
  process.exit(0);
}

const upd = await gql(
  `mutation($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
      menu { id items { id title } }
      userErrors { field message }
    }
  }`,
  { id: MENU_ID, title: menu.title, handle: menu.handle, items }
);
const ue = upd.data.menuUpdate.userErrors;
if (ue.length) {
  console.error("menuUpdate userErrors:", JSON.stringify(ue, null, 2));
  process.exit(1);
}
const updatedItems = upd.data.menuUpdate.menu.items;
console.log("\n✓ Menu updated. New first item id:", updatedItems[0].id, `"${updatedItems[0].title}"`);

// EN translation "Sale 🔥" for the new menu item
const newItemId = updatedItems[0].id;
try {
  const tr = await gql(
    `query($id: ID!){ translatableResource(resourceId:$id){ translatableContent { key value digest locale } } }`,
    { id: newItemId }
  );
  const titleC = tr.data.translatableResource?.translatableContent?.find((c) => c.key === "title");
  if (titleC) {
    const reg = await gql(
      `mutation($id: ID!, $t: [TranslationInput!]!) {
        translationsRegister(resourceId: $id, translations: $t) { userErrors { field message } }
      }`,
      { id: newItemId, t: [{ key: "title", locale: "en", value: "Sale 🔥", translatableContentDigest: titleC.digest }] }
    );
    const tue = reg.data.translationsRegister.userErrors;
    if (tue.length) console.warn("  EN menu translation userErrors:", JSON.stringify(tue));
    else console.log('✓ EN menu item translation registered: "Sale 🔥"');
  } else {
    console.warn("  Could not find translatable title for menu item; EN falls back to FR.");
  }
} catch (e) {
  console.warn("  EN menu translation skipped:", e.message);
}
