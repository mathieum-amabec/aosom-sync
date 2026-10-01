/**
 * backfill-colour-labels — fix colour option labels on existing products:
 *   1. FR store: rename English colour values to French ("Black" → "Noir", "Rustic Brown" →
 *      "Brun rustique"), via productOptionUpdate. Skips a rename that would collide with a
 *      value already on the same product (Shopify requires unique values per option).
 *   2. EN locale: register the English translation of every colour value + option names
 *      (registerOptionEnTranslations — same function the import now calls at creation).
 *
 * USAGE (x64 Node, prod creds):
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/backfill-colour-labels.mts            # dry-run
 *   …scripts/backfill-colour-labels.mts --apply [--limit=10] [--ids=123,456]
 * Resumable: applied product ids are appended to --checkpoint (default .tmp-colour-labels-done.jsonl).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import * as colourNames from "../src/lib/colour-names";
import * as shopifyClient from "../src/lib/shopify-client";
// tsx transpiles src/ to CJS, so named exports can arrive on .default.
const cn = ((colourNames as unknown as { default?: typeof colourNames }).default ?? colourNames);
const sc = ((shopifyClient as unknown as { default?: typeof shopifyClient }).default ?? shopifyClient);
const { toFrenchColour, isEnglishColour } = cn;
const { registerOptionEnTranslations } = sc;

const STORE = "27u5y2-kp.myshopify.com", API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const APPLY = process.argv.includes("--apply");
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const ONLY = arg("ids") ? new Set(arg("ids")!.split(",")) : null;
const CHECKPOINT = arg("checkpoint") ?? ".tmp-colour-labels-done.jsonl";

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
interface Prod { id: string; title: string; options: Opt[] }

async function main() {
  const done = new Set<string>(existsSync(CHECKPOINT) ? readFileSync(CHECKPOINT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
  const prods: Prod[] = [];
  let cursor: string | null = null;
  do {
    const r: { data?: { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Prod[] } } } = await gql(
      `query($c:String){products(first:100,after:$c,query:"status:active"){pageInfo{hasNextPage endCursor} nodes{id title options{id name optionValues{id name}}}}}`,
      { c: cursor },
    );
    if (!r.data) throw new Error("products query failed");
    prods.push(...r.data.products.nodes);
    cursor = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null;
  } while (cursor);

  type Plan = { p: Prod; opt: Opt; renames: { id: string; from: string; to: string }[]; collisions: string[] };
  const plans: Plan[] = [];
  for (const p of prods) {
    const pid = p.id.split("/").pop()!;
    if (ONLY && !ONLY.has(pid)) continue;
    if (done.has(p.id)) continue;
    const opt = p.options.find((o) => o.name === "Couleur");
    if (!opt) continue;
    const taken = new Set(opt.optionValues.map((v) => v.name.toLowerCase()));
    const renames: Plan["renames"] = [];
    const collisions: string[] = [];
    for (const v of opt.optionValues) {
      if (!isEnglishColour(v.name)) continue;
      const to = toFrenchColour(v.name);
      if (taken.has(to.toLowerCase())) { collisions.push(`${v.name} → ${to}`); continue; }
      taken.add(to.toLowerCase());
      renames.push({ id: v.id, from: v.name, to });
    }
    plans.push({ p, opt, renames, collisions });
  }
  const todo = plans.slice(0, LIMIT);
  const nRen = todo.reduce((n, x) => n + x.renames.length, 0);
  const nCol = todo.reduce((n, x) => n + x.collisions.length, 0);
  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} — produits avec Couleur: ${todo.length} | valeurs à renommer en FR: ${nRen} (sur ${todo.filter((x) => x.renames.length).length} produits) | conflits sautés: ${nCol}`);
  for (const x of todo.filter((x) => x.collisions.length).slice(0, 15)) console.log(`  conflit ${x.p.id.split("/").pop()} ${x.p.title}: ${x.collisions.join("; ")}`);
  const sample = todo.filter((x) => x.renames.length).slice(0, 8);
  for (const x of sample) console.log(`  ${x.p.id.split("/").pop()} ${x.p.title.slice(0, 50)}: ${x.renames.map((r) => `${r.from} → ${r.to}`).join(", ")}`);
  if (!APPLY) return;

  let ok = 0, fail = 0, translated = 0;
  for (const x of todo) {
    try {
      if (x.renames.length) {
        const r: { data?: { productOptionUpdate: { userErrors: { message: string }[] } } } = await gql(
          `mutation($p:ID!,$o:OptionUpdateInput!,$v:[OptionValueUpdateInput!]){productOptionUpdate(productId:$p,option:$o,optionValuesToUpdate:$v,variantStrategy:LEAVE_AS_IS){userErrors{message}}}`,
          { p: x.p.id, o: { id: x.opt.id }, v: x.renames.map((r) => ({ id: r.id, name: r.to })) },
        );
        const errs = r.data?.productOptionUpdate.userErrors ?? [{ message: "no data" }];
        if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
      }
      translated += await registerOptionEnTranslations(x.p.id.split("/").pop()!);
      appendFileSync(CHECKPOINT, JSON.stringify({ id: x.p.id, renamed: x.renames.length }) + "\n");
      ok++;
    } catch (err) {
      fail++;
      console.error(`  ÉCHEC ${x.p.id.split("/").pop()} ${x.p.title}: ${err instanceof Error ? err.message : err}`);
    }
    if ((ok + fail) % 100 === 0) console.log(`  … ${ok + fail}/${todo.length} (ok=${ok} échecs=${fail} traductions EN=${translated})`);
  }
  console.log(`\nTERMINÉ — produits ok=${ok} échecs=${fail} | traductions EN ajoutées=${translated}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
