import { gql, PREVIEW_THEME_ID } from "./_shopify-lib.mjs";

const gid = `gid://shopify/OnlineStoreTheme/${PREVIEW_THEME_ID}`;
const q = `query($id: ID!){
  translatableResource(resourceId:$id){
    resourceId
    translatableContent { key value digest locale }
  }
}`;
try {
  const r = await gql(q, { id: gid });
  const tr = r.data.translatableResource;
  if (!tr) { console.log("translatableResource = null for copy theme gid"); }
  else {
    const content = tr.translatableContent || [];
    console.log(`translatableContent entries: ${content.length}`);
    // show ones whose value looks like a featured-collection title
    for (const c of content) {
      if (/Mobilier|Coups|populaire|cœur|offres|deals|Featured/i.test(c.value || "")) {
        console.log(`  key=${c.key}\n    value=${JSON.stringify(c.value)} digest=${c.digest?.slice(0,12)}...`);
      }
    }
    // also dump first 8 keys to learn the key format
    console.log("\nfirst 8 keys:");
    for (const c of content.slice(0, 8)) console.log(`  ${c.key} = ${JSON.stringify((c.value||"").slice(0,40))}`);
  }
} catch (e) {
  console.log("ERR:", e.message.slice(0, 200));
}
