import { getAsset, getDraftThemeId } from "./_shopify-lib.mjs";

// Theme ids are resolved from themes.json at run time — never hardcoded.
const DRAFT_THEME_ID = await getDraftThemeId();
const idx = JSON.parse(await getAsset("templates/index.json", DRAFT_THEME_ID));
for (const [id, sec] of Object.entries(idx.sections)) {
  const cl = sec.settings?.custom_liquid;
  if (!cl) continue;
  let from = 0;
  while (true) {
    const i = cl.toLowerCase().indexOf("livraison gratuite", from);
    if (i < 0) break;
    console.log(`\n[${id} / ${sec.type}]`);
    console.log("..." + cl.slice(Math.max(0, i - 90), i + 60).replace(/\s+/g, " ") + "...");
    from = i + 5;
  }
}
