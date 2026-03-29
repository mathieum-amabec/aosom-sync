/**
 * Quick validation script — run with: npx tsx scripts/test-parser.ts
 */
import { fetchAosomCatalog } from "../src/lib/csv-fetcher";
import { mergeVariants } from "../src/lib/variant-merger";

async function main() {
  console.log("Fetching Aosom catalog...");
  const products = await fetchAosomCatalog();
  console.log(`Parsed ${products.length} product rows`);

  // Sample first product
  const first = products[0];
  console.log("\n--- First product ---");
  console.log(`SKU: ${first.sku}`);
  console.log(`Name: ${first.name}`);
  console.log(`Price: $${first.price}`);
  console.log(`Qty: ${first.qty}`);
  console.log(`Color: ${first.color}`);
  console.log(`Size: ${first.size}`);
  console.log(`Brand: ${first.brand}`);
  console.log(`Product Type: ${first.productType}`);
  console.log(`Images: ${first.images.length}`);
  console.log(`PSIN: ${first.psin}`);
  console.log(`Has [BRAND NAME]: ${first.description.includes("[BRAND NAME]")}`);

  // Merge variants
  console.log("\nMerging variants...");
  const merged = mergeVariants(products);
  console.log(`Merged into ${merged.length} products`);

  // Stats
  const multiVariant = merged.filter((m) => m.variants.length > 1);
  console.log(`Multi-variant products: ${multiVariant.length}`);
  if (multiVariant.length > 0) {
    const sample = multiVariant[0];
    console.log(`\n--- Sample multi-variant: ${sample.name} ---`);
    console.log(`Group key: ${sample.groupKey}`);
    console.log(`Variants: ${sample.variants.length}`);
    for (const v of sample.variants) {
      console.log(`  - ${v.sku}: color=${v.color}, size=${v.size}, price=$${v.price}, qty=${v.qty}`);
    }
  }

  // Product type breakdown
  const typeCounts = new Map<string, number>();
  for (const p of products) {
    const topLevel = p.productType.split(">")[0].trim();
    if (topLevel) typeCounts.set(topLevel, (typeCounts.get(topLevel) || 0) + 1);
  }
  console.log("\n--- Top-level categories ---");
  for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${type}: ${count}`);
  }
}

main().catch(console.error);
