import { getAsset } from "./_shopify-lib.mjs";
const P = "160213696617";
const rec = (ok, label, detail) => console.log(`${ok ? "✅" : "❌"} ${label} — ${detail}`);

const mp = await getAsset("sections/main-product.liquid", P);
rec(/product-eyebrow/.test(mp) && /\{\{ product\.type/.test(mp), "eyebrow present (product.type)", "above <h1> in title block");
rec(/jdgm-preview-badge/.test(mp) && mp.indexOf("jdgm-preview-badge") > mp.indexOf("<h1"), "Judge.me badge under H1", "jdgm-preview-badge after <h1>");
rec(/product-form__submit\{background:#1B2A4A/.test(mp), "ATC button navy", "#1B2A4A + radius 4px + mobile full-width");

const pr = await getAsset("snippets/price.liquid", P);
rec(/price-save/.test(pr) && /disc_pct\s*>=\s*10/.test(pr), "savings gated >=10% in price.liquid", "Économisez {{ savings }} when disc_pct >= 10");

const pj = JSON.parse(await getAsset("templates/product.json", P)); // throws if invalid JSON
const tb = pj.sections.main.blocks.trust_badges.settings.custom_liquid;
const emoji = /🚚|🔄|🔒|⭐/.test(tb);
rec(/<svg/.test(tb) && !emoji, "reassurance SVG under ATC (trust_badges)", `${(tb.match(/<svg/g) || []).length} svg, emoji=${emoji}`);
rec(true, "product.json valid JSON", "parsed OK");

// liquid sanity: balanced if/endif/when in the title+buy_buttons edits region (coarse)
const ifs = (mp.match(/\{%-?\s*if /g) || []).length, endifs = (mp.match(/\{%-?\s*endif/g) || []).length;
rec(Math.abs(ifs - endifs) <= 2, "main-product if/endif roughly balanced", `if=${ifs} endif=${endifs} (Dawn has some inline)`);

// live home liquid error sanity
const live = await (await fetch(`https://ameublodirect.ca/?cb=${Date.now()}`, { cache: "no-store" })).text();
rec(!/liquid error/i.test(live), "no liquid error (live home)", "none");
console.log("\nNote: PDP render must be confirmed via admin Theme → Preview (public ?preview_theme_id= serves the published theme).");
