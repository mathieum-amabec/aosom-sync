/**
 * Dry run of the compare-at sync against the real catalogue. READ-ONLY: reads Turso and Shopify, writes nothing
 * (the plan is not even stored). Prints the counts and writes the changes to a CSV.
 *
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/compare-at-dry-run.mts <out.csv>
 */
import { writeFileSync } from "node:fs";
import * as CompareMod from "../src/lib/compare-at";
import * as DbMod from "../src/lib/compare-at-db";

// tsx exposes these modules' exports on `default` when run as a script (see memory ops-mts-scripts-against-prod).
const { runCompareAtSync } = ((CompareMod as unknown as { default?: typeof CompareMod }).default ?? CompareMod) as typeof CompareMod;
const { defaultCompareAtDeps } = ((DbMod as unknown as { default?: typeof DbMod }).default ?? DbMod) as typeof DbMod;

const out = process.argv[2];
if (!out) throw new Error("usage: compare-at-dry-run.mts <out.csv>");

const r = await runCompareAtSync({ deps: defaultCompareAtDeps(), mode: "dry", persistPlan: false });
const set = r.plan.changes.filter((c) => c.action === "set");
const clear = r.plan.changes.filter((c) => c.action === "clear");
const pcts = set.map((c) => ((c.to! - c.price) / c.to!) * 100).sort((a, b) => a - b);
const q = (p: number) => (pcts.length ? pcts[Math.floor(pcts.length * p)].toFixed(0) : "-");

writeFileSync(out, ["sku,action,prix_actuel,ancien_prix_actuel,ancien_prix_propose,rabais_pct"].concat(
  r.plan.changes.map((c) => [c.sku, c.action, c.price, c.from ?? "", c.to ?? "", c.to ? (((c.to - c.price) / c.to) * 100).toFixed(0) : ""].join(",")),
).join("\n"));

console.log("variantes lues sur Shopify:", r.variantsSeen, r.skipped ? `(${r.skipped})` : "");
console.log("à AJOUTER:", set.length, `| rabais p10 ${q(0.1)} % · médiane ${q(0.5)} % · p90 ${q(0.9)} %`);
console.log("à RETIRER (prix barré invalide):", clear.length);
console.log("déjà valides (gardés):", r.plan.keptValid, "| sans historique:", r.plan.noHistory, "| écart de prix Shopify/base (attendre):", r.plan.skippedDrift, "| déjà corrects:", r.plan.alreadyRight);
console.log("CSV:", out);
