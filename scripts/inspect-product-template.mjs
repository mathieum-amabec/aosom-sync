// Inspect the live theme's templates/product.json: list sections/blocks and find
// the price-alert custom_liquid block. Read-only.
import { getAsset } from "./_shopify-lib.mjs";

const LIVE_THEME = "160059195497";
const raw = await getAsset("templates/product.json", LIVE_THEME);
const tpl = JSON.parse(raw);

console.log("=== sections ===");
for (const [sid, section] of Object.entries(tpl.sections ?? {})) {
  console.log(`section "${sid}" type=${section.type}`);
  for (const [bid, block] of Object.entries(section.blocks ?? {})) {
    const liquid = block.settings?.custom_liquid;
    const isAlert = typeof liquid === "string" && /price-alert|api\/price-alert/.test(liquid);
    console.log(`  block "${bid}" type=${block.type}${isAlert ? "  <-- PRICE ALERT" : ""}`);
    if (isAlert) {
      console.log("  --- current custom_liquid length:", liquid.length);
      console.log("  --- data-ok line(s):");
      for (const line of liquid.split(/\r?\n/)) {
        if (line.includes("data-ok") || line.includes("data-err") || line.includes("check your email") || line.includes("courriel")) {
          console.log("      " + line.trim());
        }
      }
    }
  }
  // also report block_order so we preserve it
  if (section.block_order) console.log(`  block_order: ${JSON.stringify(section.block_order)}`);
}
