/**
 * Record the reviewer agents' verdicts on Studio Ameublo videos (qa_verdict / qa_notes only).
 * It never approves, schedules or rejects anything: a "fail" just blocks the Approve button unless
 * the operator forces it.
 *
 *   node-x64 --env-file=../aosom-sync/.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/ameublo-qa-apply.mts --file verdicts.json [--apply]
 *
 * verdicts.json: [{ "id": 37, "verdict": "pass" | "fail" | "review", "notes": "..." }]
 * Without --apply it only prints what it would write.
 */
import fs from "node:fs";
import type { AmeubloQa } from "@/lib/database";

const dbMod = (await import("@/lib/database")) as typeof import("@/lib/database");
const { setAmeubloQa } = (dbMod as { default?: typeof dbMod }).default ?? dbMod;

const argv = process.argv.slice(2);
const file = argv[argv.indexOf("--file") + 1];
const apply = argv.includes("--apply");
if (!file || !fs.existsSync(file)) {
  console.error("usage: --file verdicts.json [--apply]");
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(file, "utf8")) as { id: number; verdict: AmeubloQa; notes?: string }[];
const tally: Record<string, number> = {};
for (const r of rows) {
  if (!["pass", "fail", "review"].includes(r.verdict)) throw new Error(`bad verdict for #${r.id}: ${r.verdict}`);
  tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
  if (apply) await setAmeubloQa(r.id, r.verdict, r.notes?.slice(0, 600) ?? null);
}
console.log(apply ? "written:" : "dry-run:", tally);
