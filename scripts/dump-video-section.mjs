import { getAsset, DRAFT_THEME_ID } from "./_shopify-lib.mjs";
const s = await getAsset("sections/home-video-showcase.liquid", DRAFT_THEME_ID);
console.log(s);
