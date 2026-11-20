/**
 * backfill-metric-sizes — convert imperial "Taille" option values (inches / feet) to metric on EXISTING products.
 * Mat, 2026-11-19: metric everywhere. New imports already do it at creation (convertImperialSize, shopify-client);
 * ~40 % of the imports between 2026-10-20 and 2026-11-19 reached the store with `9.3" x 9.3" x 72.4"` style values.
 *
 *   - FR store: productOptionUpdate renames the value (variants keep their id; the title of each variant follows).
 *   - EN locale: the original Aosom wording is registered as the EN translation (registerOptionEnTranslations).
 *   - A rename that would collide with another value of the same option is skipped.
 *   - Cross-check: when the product has a `custom.lc_dims` size and the new label carries a metric cue, at least one
 *     SKU's size must agree (±6 %). A contradiction is NOT written — it is listed for a human look.
 *
 * USAGE (x64 Node, prod creds):
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/backfill-metric-sizes.mts            # dry-run
 *   …scripts/backfill-metric-sizes.mts --apply [--limit=10] [--ids=123,456]
 * Resumable: applied product ids are appended to --checkpoint (default .tmp-metric-sizes-done.jsonl).
 * Rollback: --rollback=<backup.jsonl> --apply renames every value back from the backup written on apply.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as contentGuards from "../src/lib/content-guards";
import * as shopifyClient from "../src/lib/shopify-client";
import * as fitDims from "../src/lib/fit-dims";
const cg = ((contentGuards as unknown as { default?: typeof contentGuards }).default ?? contentGuards);
const sc = ((shopifyClient as unknown as { default?: typeof shopifyClient }).default ?? shopifyClient);
const fd = ((fitDims as unknown as { default?: typeof fitDims }).default ?? fitDims);
const { convertImperialSize } = cg;
const { registerOptionEnTranslations } = sc;
const { metricCues } = fd;

const STORE = "27u5y2-kp.myshopify.com", API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const APPLY = process.argv.includes("--apply");
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const ONLY = arg("ids") ? new Set(arg("ids")!.split(",")) : null;
const CHECKPOINT = arg("checkpoint") ?? ".tmp-metric-sizes-done.jsonl";
const BACKUP = arg("backup") ?? ".tmp-metric-sizes-backup.jsonl";
const ROLLBACK = arg("rollback");

let last = 0;
async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<{ data?: T; errors?: { message: string }[] }> {
  for (let a = 0; a < 6; a++) {
    const wait = 520 - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const res = await fetch(`https://${STORE}/admin/api/${API}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const j = await res.json();
    if (res.status === 429 || j.errors?.some((e: { message: string }) => /throttl/i.test(e.message))) {
      await new Promise((r) => setTimeout(r, 3000 * (a + 1)));
      continue;
    }
    return j;
  }
  throw new Error("throttled");
}

interface Opt { id: string; name: string; optionValues: { id: string; name: string }[] }
interface Prod { id: string; title: string; options: Opt[]; metafield: { value: string } | null }

const sortDesc = (a: number[]) => [...a].sort((x, y) => y - x);
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(3, b * 0.06);

/** SKU sizes (cm, sorted) stored for the product. */
function storedSizes(metafield: string | null): number[][] {
  if (!metafield) return [];
  try {
    const j = JSON.parse(metafield) as { s?: Record<string, { p?: number[] }> };
    return Object.values(j.s ?? {}).flatMap((e) => (e.p ? [sortDesc(e.p)] : []));
  } catch { return []; }
}
/** every figure of the cue matches a DIFFERENT dimension of one stored SKU size. */
function cueFits(cue: number[], size: number[]): boolean {
  const left = [...size];
  let hit = 0;
  for (const v of cue) { const i = left.findIndex((x) => near(v, x)); if (i >= 0) { left.splice(i, 1); hit++; } }
  // A three-figure label with an adjustable range ("88-109 cm H") only needs its other figures to agree.
  return cue.length >= 3 ? hit >= cue.length - 1 : hit === cue.length;
}
/** true when the label's metric figures contradict every SKU size stored for the product. */
function contradicts(label: string, metafield: string | null): boolean {
  const sizes = storedSizes(metafield);
  const cues = metricCues(label).filter((c) => c.length >= 2);
  if (!sizes.length || !cues.length) return false;
  return !cues.some((c) => sizes.some((s) => cueFits(c, s)));
}
/** Convert one value; a lone apostrophe (feet on a shed, inches on a stool) is decided by the stored size. */
function convertValue(value: string, metafield: string | null): { to: string; note?: string } {
  if (!/\d\s*'(?!')/.test(value)) return { to: convertImperialSize(value) };
  const asFt = convertImperialSize(value, "fr", "ft"), asIn = convertImperialSize(value, "fr", "in");
  const sizes = storedSizes(metafield);
  // A shed sold as "9' x 6'" is a nominal footprint, its outer size is bigger. The label's LARGEST figure must land on the
  // LARGEST stored dimension of some SKU, and only the feet reading may do so (an apostrophe read as inches once turned a
  // gazebo curtain "10' x 12'" into 25 x 30 cm because a 30 cm thickness matched).
  const fits = (label: string) => metricCues(label).some((c) => sizes.some((s) => near(Math.max(...c), Math.max(...s))));
  // Mixed ' and " in one label ("4' x 10' x 2\"") is left to a human.
  if (/\d\s*"/.test(value) || /\d\s*''/.test(value)) return { to: value, note: "unités mélangées" };
  if (fits(asFt) && !fits(asIn)) return { to: asFt };
  return { to: value, note: "apostrophe ambiguë" };
}

async function rollback(file: string) {
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { product: string; option: string; renames: { id: string; from: string; to: string }[] });
  for (const r of rows) {
    console.log(`${APPLY ? "ROLLBACK" : "DRY"} ${r.product}: ${r.renames.map((x) => `${x.to} → ${x.from}`).join(", ")}`);
    if (!APPLY) continue;
    const res: { data?: { productOptionUpdate: { userErrors: { message: string }[] } } } = await gql(
      `mutation($p:ID!,$o:OptionUpdateInput!,$v:[OptionValueUpdateInput!]){productOptionUpdate(productId:$p,option:$o,optionValuesToUpdate:$v,variantStrategy:LEAVE_AS_IS){userErrors{message}}}`,
      { p: r.product, o: { id: r.option }, v: r.renames.map((x) => ({ id: x.id, name: x.from })) },
    );
    const errs = res.data?.productOptionUpdate.userErrors ?? [{ message: "no data" }];
    if (errs.length) console.error(`  ÉCHEC ${r.product}: ${errs.map((e) => e.message).join("; ")}`);
  }
}

async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);
  const done = new Set<string>(existsSync(CHECKPOINT) ? readFileSync(CHECKPOINT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
  const prods: Prod[] = [];
  let cursor: string | null = null;
  do {
    const r: { data?: { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Prod[] } } } = await gql(
      `query($c:String){products(first:100,after:$c,query:"status:active"){pageInfo{hasNextPage endCursor} nodes{id title options{id name optionValues{id name}} metafield(namespace:"custom",key:"lc_dims"){value}}}}`,
      { c: cursor },
    );
    if (!r.data) throw new Error("products query failed");
    prods.push(...r.data.products.nodes);
    cursor = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null;
  } while (cursor);

  type Plan = { p: Prod; opt: Opt; renames: { id: string; from: string; to: string }[]; skipped: string[] };
  const plans: Plan[] = [];
  for (const p of prods) {
    const pid = p.id.split("/").pop()!;
    if (ONLY && !ONLY.has(pid)) continue;
    if (done.has(p.id)) continue;
    const opt = p.options.find((o) => o.name === "Taille");
    if (!opt) continue;
    const taken = new Set(opt.optionValues.map((v) => v.name.toLowerCase()));
    const renames: Plan["renames"] = [];
    const skipped: string[] = [];
    for (const v of opt.optionValues) {
      const cv = convertValue(v.name, p.metafield?.value ?? null);
      const to = cv.to;
      if (cv.note) { skipped.push(`${cv.note}: ${v.name}`); continue; }
      if (!to || to === v.name) continue;
      if (taken.has(to.toLowerCase())) { skipped.push(`collision ${v.name} → ${to}`); continue; }
      if (contradicts(to, p.metafield?.value ?? null)) { skipped.push(`contredit la taille stockée: ${v.name} → ${to}`); continue; }
      taken.add(to.toLowerCase());
      renames.push({ id: v.id, from: v.name, to });
    }
    if (renames.length || skipped.length) plans.push({ p, opt, renames, skipped });
  }
  const todo = plans.slice(0, LIMIT);
  const nRen = todo.reduce((n, x) => n + x.renames.length, 0);
  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} — produits actifs: ${prods.length} | avec valeurs impériales: ${todo.length} | valeurs à convertir: ${nRen} | sautées: ${todo.reduce((n, x) => n + x.skipped.length, 0)}`);
  for (const x of todo.filter((x) => x.skipped.length).slice(0, 40)) console.log(`  SAUTÉ ${x.p.id.split("/").pop()} ${x.p.title.slice(0, 50)}: ${x.skipped.join("; ")}`);
  for (const x of todo.filter((x) => x.renames.length).slice(0, 25)) console.log(`  ${x.p.id.split("/").pop()} ${x.p.title.slice(0, 45)}: ${x.renames.map((r) => `${r.from} → ${r.to}`).join(" | ")}`);
  writeFileSync(".tmp-metric-sizes-plan.json", JSON.stringify(todo.map((x) => ({ id: x.p.id, title: x.p.title, renames: x.renames, skipped: x.skipped })), null, 1));
  if (!APPLY) return;

  let ok = 0, fail = 0, translated = 0;
  for (const x of todo) {
    if (!x.renames.length) continue;
    try {
      appendFileSync(BACKUP, JSON.stringify({ product: x.p.id, option: x.opt.id, renames: x.renames }) + "\n");
      const r: { data?: { productOptionUpdate: { userErrors: { message: string }[] } } } = await gql(
        `mutation($p:ID!,$o:OptionUpdateInput!,$v:[OptionValueUpdateInput!]){productOptionUpdate(productId:$p,option:$o,optionValuesToUpdate:$v,variantStrategy:LEAVE_AS_IS){userErrors{message}}}`,
        { p: x.p.id, o: { id: x.opt.id }, v: x.renames.map((r) => ({ id: r.id, name: r.to })) },
      );
      const errs = r.data?.productOptionUpdate.userErrors ?? [{ message: "no data" }];
      if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
      translated += await registerOptionEnTranslations(x.p.id.split("/").pop()!, new Map(x.renames.map((r) => [r.to, r.from])));
      appendFileSync(CHECKPOINT, JSON.stringify({ id: x.p.id, renamed: x.renames.length }) + "\n");
      ok++;
    } catch (err) {
      fail++;
      console.error(`  ÉCHEC ${x.p.id.split("/").pop()} ${x.p.title}: ${err instanceof Error ? err.message : err}`);
    }
    if ((ok + fail) % 50 === 0) console.log(`  … ${ok + fail}/${todo.length} (ok=${ok} échecs=${fail} traductions EN=${translated})`);
  }
  console.log(`\nTERMINÉ — produits ok=${ok} échecs=${fail} | traductions EN ajoutées=${translated}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
