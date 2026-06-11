import { getAsset } from "./_shopify-lib.mjs";
const PREVIEW = "160213696617", LIVE = "160059195497";

// 1. header-group diff — what menu does each use + announcement
const ph = await getAsset("sections/header-group.json", PREVIEW);
const lh = await getAsset("sections/header-group.json", LIVE);
const menuOf = (s) => [...s.matchAll(/"menu"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).join(",") || "(none in regex)";
console.log("preview menu:", menuOf(ph));
console.log("live menu   :", menuOf(lh));
// show first divergence
let i = 0; while (i < Math.min(ph.length, lh.length) && ph[i] === lh[i]) i++;
console.log(`first divergence at char ${i}:`);
console.log("  preview:", JSON.stringify(ph.slice(i - 30, i + 40)));
console.log("  live   :", JSON.stringify(lh.slice(i - 30, i + 40)));

// 2. Meta Pixel in rendered live HTML (could be injected via ScriptTag/app)
const html = await (await fetch(`https://ameublodirect.ca/?cb=${Date.now()}`, { cache: "no-store" })).text();
console.log("\n--- Meta Pixel (rendered live HTML) ---");
console.log("fbq( present:", /fbq\s*\(/.test(html));
console.log("connect.facebook.net:", /connect\.facebook\.net/.test(html));
console.log("fbevents.js:", /fbevents/.test(html));
const fbid = html.match(/fbq\('init',\s*'?(\d+)/) || html.match(/facebook[^0-9]{0,20}(\d{15,16})/);
console.log("pixel id-ish:", fbid ? fbid[1] : "(none found)");
console.log("Umami in rendered HTML:", /umami/i.test(html));
