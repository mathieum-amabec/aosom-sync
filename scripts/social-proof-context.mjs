import { getAsset, getDraftThemeId } from "./_shopify-lib.mjs";

// Theme ids are resolved from themes.json at run time — never hardcoded.
const DRAFT_THEME_ID = await getDraftThemeId();
const PREVIEW = DRAFT_THEME_ID;
const idx = JSON.parse(await getAsset("templates/index.json", PREVIEW));
for (const [id, sec] of Object.entries(idx.sections)) {
  const cl = sec.settings?.custom_liquid;
  if (cl && cl.includes("500")) {
    console.log(`\n===== section ${id} [${sec.type}] =====`);
    let from = 0;
    while (true) {
      const i = cl.indexOf("500", from);
      if (i < 0) break;
      console.log(`...${cl.slice(Math.max(0, i - 120), i + 60)}...`);
      from = i + 3;
    }
  }
}
