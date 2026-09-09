import { getAsset, getDraftThemeId } from "./_shopify-lib.mjs";

// Theme ids are resolved from themes.json at run time — never hardcoded.
const DRAFT_THEME_ID = await getDraftThemeId();
const s = await getAsset("sections/home-video-showcase.liquid", DRAFT_THEME_ID);
console.log(s);
