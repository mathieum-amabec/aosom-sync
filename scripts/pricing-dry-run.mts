/**
 * Dry run of the sell-price rule over every product linked to Shopify. READ-ONLY: reads Turso, the competitor's public
 * catalogue and the Aosom feed; writes nothing to Turso or Shopify, only a CSV to the path given.
 *
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/pricing-dry-run.mts <out.csv>
 */
import { writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { parse } from "csv-parse/sync";
import * as RuleMod from "../src/lib/sell-price-rule";
import * as CompMod from "../src/lib/competitor-prices";

// tsx exposes these modules' exports on `default` when run as a script (see memory ops-mts-scripts-against-prod).
const { computeSellPrice } = ((RuleMod as unknown as { default?: typeof RuleMod }).default ?? RuleMod) as typeof RuleMod;
const { fetchCompetitorPrices } = ((CompMod as unknown as { default?: typeof CompMod }).default ?? CompMod) as typeof CompMod;

const out = process.argv[2];
if (!out) throw new Error("usage: pricing-dry-run.mts <out.csv>");

const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
const rows = (await db.execute("SELECT sku, price, product_type FROM products WHERE price > 0 AND shopify_product_id IS NOT NULL AND shopify_product_id != ''")).rows;
console.log("produits liés à Shopify:", rows.length);

const competitor = await fetchCompetitorPrices();
console.log("prix concurrent:", competitor ? `${competitor.size} SKUs` : "INDISPONIBLE (repli sur les paliers)");

// Cost model: B2B price + shipping fee from the feed (assumption, see memory competitor-ameublementarabais-pricing).
const feedUrl = process.env.AOSOM_FEED_URL || "https://feed-us.aosomcdn.com/390/110_feed/0/0/5e/c4857d.csv";
const feedText = await (await fetch(feedUrl)).text();
const feed = parse(feedText, { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true }) as Array<Record<string, string>>;
const cost = new Map<string, number>();
for (const r of feed) {
  const b = parseFloat(r["2B Product Price"]);
  const s = parseFloat(r["shiping_fee"]) || 0;
  if (b > 0 && r.SKU) cost.set(r.SKU.trim(), b + s);
}

const lines = ["sku,product_type,aosom,competitor,new_price,reason,cost,margin_before_pct,margin_after_pct"];
const reasons: Record<string, number> = {};
let n = 0, raised = 0, sumOld = 0, sumNew = 0, nCost = 0, below = 0, atOrAbove = 0, hasComp = 0, ignored = 0;
const underCostAfter: string[] = [];
const pcts: number[] = [];
for (const r of rows) {
  const sku = String(r.sku).trim();
  const aosom = Number(r.price);
  const comp = competitor?.get(sku.toUpperCase()) ?? null;
  const res = computeSellPrice({ aosomPrice: aosom, productType: String(r.product_type ?? ""), competitorPrice: comp });
  if (!Number.isFinite(res.price)) continue;
  n++;
  reasons[res.reason] = (reasons[res.reason] ?? 0) + 1;
  sumOld += aosom; sumNew += res.price;
  if (res.price > aosom + 0.005) { raised++; pcts.push((res.price / aosom - 1) * 100); }
  if (comp && !res.competitorIgnored) { hasComp++; if (res.price < comp) below++; else atOrAbove++; }
  if (res.competitorIgnored) ignored++;
  const c = cost.get(sku);
  let mb = "", ma = "";
  if (c) { nCost++; mb = (((aosom - c) / aosom) * 100).toFixed(1); ma = (((res.price - c) / res.price) * 100).toFixed(1); if (res.price < c) underCostAfter.push(`${sku} ${res.price} < coût ${c.toFixed(2)}`); }
  lines.push([sku, JSON.stringify(String(r.product_type ?? "")), aosom, comp ?? "", res.price, res.reason, c?.toFixed(2) ?? "", mb, ma].join(","));
}
writeFileSync(out, lines.join("\n"));

pcts.sort((a, b) => a - b);
const q = (p: number) => (pcts.length ? pcts[Math.floor(pcts.length * p)].toFixed(1) : "-");
console.log("\n== RÉSULTAT (simulation, rien d'écrit)");
console.log("produits:", n, "| prix en hausse:", raised, `(${((raised / n) * 100).toFixed(0)} %)`, "| inchangés:", n - raised);
console.log("raisons:", JSON.stringify(reasons));
console.log("hausse sur les produits touchés: p10", q(0.1), "% | médiane", q(0.5), "% | p90", q(0.9), "%");
console.log("hausse moyenne pondérée (tout le catalogue):", ((sumNew / sumOld - 1) * 100).toFixed(2), "%");
console.log("comparables au concurrent (prix plausible):", hasComp, "| nous strictement moins chers:", below, "| égaux ou plus chers (plancher Aosom):", atOrAbove, "| prix concurrent ignorés (incohérents):", ignored);
if (nCost) {
  let oldC = 0, oldR = 0, newR = 0;
  for (const r of rows) { const sku = String(r.sku).trim(); const c = cost.get(sku); if (!c) continue; const a = Number(r.price); const res = computeSellPrice({ aosomPrice: a, productType: String(r.product_type ?? ""), competitorPrice: competitor?.get(sku.toUpperCase()) ?? null }); if (!Number.isFinite(res.price)) continue; oldC += c; oldR += a; newR += res.price; }
  console.log(`marge (coût = B2B + livraison, ${nCost} produits): avant ${((1 - oldC / oldR) * 100).toFixed(1)} % -> après ${((1 - oldC / newR) * 100).toFixed(1)} % | seuil pub (ROAS) ${(oldR / (oldR - oldC)).toFixed(1)} -> ${(newR / (newR - oldC)).toFixed(1)}`);
  console.log("encore sous le coût après la règle:", underCostAfter.length, underCostAfter.slice(0, 5));
}
console.log("CSV:", out);
