// Update the live theme's price_drop_alert custom_liquid block with the current
// double-opt-in snippet (docs/snippets/price-drop-alert.liquid).
//
//   node scripts/update-price-alert-block.mjs           # dry run (no write)
//   node scripts/update-price-alert-block.mjs --apply    # PUT templates/product.json
//
// Only the price_drop_alert block's `custom_liquid` setting is touched; every other
// section, block, and block_order is preserved exactly.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getAsset, putAsset } from "./_shopify-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIVE_THEME = "160059195497";
const APPLY = process.argv.includes("--apply");

const snippet = readFileSync(join(__dirname, "..", "docs", "snippets", "price-drop-alert.liquid"), "utf8");

const raw = await getAsset("templates/product.json", LIVE_THEME);
const tpl = JSON.parse(raw);

// Locate the price-alert custom_liquid block (by known id, else by content match).
let target = null;
for (const section of Object.values(tpl.sections ?? {})) {
  for (const [bid, block] of Object.entries(section.blocks ?? {})) {
    const liquid = block.settings?.custom_liquid;
    if (block.type === "custom_liquid" && typeof liquid === "string" &&
        (bid === "price_drop_alert" || /price-alert__form|api\/price-alert/.test(liquid))) {
      target = block;
    }
  }
}
if (!target) {
  console.error("ERROR: price-alert block not found in templates/product.json");
  process.exit(1);
}

const before = target.settings.custom_liquid;
const okLine = (s) => (s.split(/\r?\n/).find((l) => l.includes("data-ok")) || "").trim();
console.log("BEFORE data-ok:", okLine(before));
console.log("AFTER  data-ok:", okLine(snippet));
console.log(`block length: ${before.length} -> ${snippet.length}`);

if (before === snippet) {
  console.log("No change — live block already matches the snippet. Nothing to do.");
  process.exit(0);
}

target.settings.custom_liquid = snippet;
const next = JSON.stringify(tpl, null, 2);

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to PUT templates/product.json to the live theme.");
  process.exit(0);
}

const result = await putAsset("templates/product.json", next, LIVE_THEME);
console.log("PUT ok — asset key:", result?.asset?.key, "updated_at:", result?.asset?.updated_at);
