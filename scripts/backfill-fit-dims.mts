/**
 * backfill-fit-dims — operator run of the `custom.lc_dims` sync (src/lib/fit-dims-sync.ts), the same pass the daily
 * cron /api/cron/fit-dims makes. Done once for the whole catalogue on 2026-10-20 (3106 products, Mat's OK).
 *
 * Guardrails (in the lib): only changed values are written; products with no SKU in the feed and products whose page
 * states another size are left alone; only the `custom.lc_dims` key is touched; ≤ 500 writes per run.
 *
 * USAGE (x64 Node, prod creds, through tsx):
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/backfill-fit-dims.mts               # dry-run
 *   …scripts/backfill-fit-dims.mts --apply [--limit=25]
 * Writes .tmp-fit-dims-plan.csv (planned values) and .tmp-fit-dims-conflicts.txt for review.
 */
import { writeFileSync } from "node:fs";
import * as syncNs from "../src/lib/fit-dims-sync";

// tsx compiles src/ to CJS here, so the named exports can arrive on `default` instead.
const unwrap = <T,>(ns: T): T => ((ns as unknown as { default?: T }).default ?? ns);
const { syncFitDims } = unwrap(syncNs);

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1];

async function main() {
  if (!process.env.SHOPIFY_ACCESS_TOKEN) throw new Error("SHOPIFY_ACCESS_TOKEN missing");
  const r = await syncFitDims({ apply: APPLY, limit: limitArg ? Number(limitArg) : undefined });
  writeFileSync(".tmp-fit-dims-plan.csv", "id,handle,status,skus,with_dims,value\n" + r.plan.map((x) => [x.id, x.handle, x.status, x.skus, x.matched, `"${x.value.replace(/"/g, '""')}"`].join(",")).join("\n"));
  writeFileSync(".tmp-fit-dims-conflicts.txt", r.conflicts.join("\n"));
  const { plan, conflicts, ...summary } = r;
  console.log(summary);
  for (const x of plan.slice(0, 5)) console.log(" ", x.handle, x.value.slice(0, 160));
  console.log(`${conflicts.length} conflicts, plan in .tmp-fit-dims-plan.csv`);
  if (!APPLY) console.log("DRY-RUN — nothing written. Re-run with --apply.");
}

main().catch((e) => { console.error(e); process.exit(1); });
