import { getAsset } from "./_shopify-lib.mjs";
const s = await getAsset("sections/home-video-showcase.liquid", "160213696617");
console.log(s);
