#!/usr/bin/env tsx
/**
 * scripts/costway-setup-shopify.mts — Shopify setup the Costway pilot import needs (see
 * src/lib/costway/shopify-setup.ts for the why).
 *
 *   a) rabais-2e-article  → add the rule `tag != src-c` (Costway excluded from the 2nd-item rebate)
 *   b) collections        → Déshumidificateurs, Buanderie (published), Suivi — source C (internal, UNpublished)
 *                           + their EN titles
 *   c) menu               → put the two category collections under « Électro & Tech » (explicit flag)
 *
 * DRY-RUN by default: read-only queries, prints the exact plan. Nothing is written without --apply.
 *
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/costway-setup-shopify.mts            # plan
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/costway-setup-shopify.mts --apply    # a) + b)
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/costway-setup-shopify.mts --apply --menu   # a) + b) + c)
 *
 * `--menu` alone is still a dry-run: the menu is only written with BOTH flags. Run the menu step when
 * the pilot products are about to go live (an empty category in the menu is a dead page).
 * Rate limit: one Admin API call every 520 ms (≈1.9 req/s).
 */
import type { ShopifyFetchLike, NewMenuChild } from "@/lib/costway/shopify-setup";

// tsx runs this file as CJS: named exports of an ESM-style module arrive on `default`.
type SetupLib = typeof import("@/lib/costway/shopify-setup");
const loaded = (await import("@/lib/costway/shopify-setup")) as unknown as SetupLib & { default?: SetupLib };
const {
  ShopifySetupClient,
  COLLECTION_SPECS,
  COSTWAY_TAG,
  ELECTRO_COLLECTION_GID,
  TAXONOMY_MENU_GID,
  planRabais,
  applyRabais,
  planCollections,
  applyCollections,
  registerEnTitle,
  fetchMenu,
  planMenu,
  applyMenu,
  countMenuEnTranslations,
} = loaded.default ?? loaded;

const STORE = "27u5y2-kp.myshopify.com";
const API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const APPLY = process.argv.includes("--apply") && !process.argv.includes("--dry-run");
const MENU = process.argv.includes("--menu");
if (!TOKEN) throw new Error("SHOPIFY_ACCESS_TOKEN missing (run with --env-file=.env.local)");

let last = 0;
const fetchFn: ShopifyFetchLike = async (endpoint, init) => {
  const wait = 520 - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  return fetch(`https://${STORE}/admin/api/${API}${endpoint}`, {
    method: init?.method ?? "GET",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: init?.body,
  });
};
const client = new ShopifySetupClient(fetchFn);

const fmtRule = (r: { column: string; relation: string; condition: string }) => `${r.column} ${r.relation} "${r.condition}"`;
const hr = (t: string) => console.log(`\n══ ${t} ${"═".repeat(Math.max(0, 70 - t.length))}`);

async function main(): Promise<void> {
  console.log(`costway-setup-shopify — ${APPLY ? "APPLY" : "DRY-RUN"}${MENU ? " + menu" : ""} — store ${STORE}`);

  // ── a) rabais-2e-article ──────────────────────────────────────────────────────────────
  hr("a) rabais-2e-article (BXGY « 10 % sur le 2e article »)");
  const rabais = await planRabais(client);
  console.log(`collection ${rabais.id.split("/").pop()} "${rabais.title}" [${rabais.handle}] — ${rabais.count} products`);
  console.log(`  current  (${rabais.current.appliedDisjunctively ? "OR" : "AND"}): ${rabais.current.rules.map(fmtRule).join("  AND  ")}`);
  console.log(`  desired  (${rabais.desired.appliedDisjunctively ? "OR" : "AND"}): ${rabais.desired.rules.map(fmtRule).join("  AND  ")}`);
  console.log(rabais.changed ? `  → CHANGE: add  TAG NOT_EQUALS "${COSTWAY_TAG}"  (product count must stay ${rabais.count})` : "  → already excludes Costway — nothing to do");

  // ── b) collections ────────────────────────────────────────────────────────────────────
  hr("b) collections");
  const colPlan = await planCollections(client);
  for (const item of colPlan) {
    const s = item.spec;
    console.log(
      `  ${item.exists ? "EXISTS " : "CREATE "} ${s.handle.padEnd(28)} "${s.title}"  ${s.published ? "PUBLISHED" : "UNPUBLISHED (internal)"}` +
        (item.exists ? `  [id ${item.existing!.id.split("/").pop()}, ${item.existing!.count} products — left untouched]` : ""),
    );
    console.log(`           rules (${s.disjunctive ? "OR" : "AND"}): ${s.rules.map(fmtRule).join("  |  ")}`);
    console.log(`           EN title: "${s.enTitle}"`);
    console.log(`           ${s.note}`);
  }

  // ── c) menu ───────────────────────────────────────────────────────────────────────────
  hr("c) menu taxonomie-categories → « Électro & Tech »");
  const menu = await fetchMenu(client, TAXONOMY_MENU_GID);
  const gidByHandle = new Map<string, string>();
  for (const item of colPlan) if (item.existing) gidByHandle.set(item.spec.handle, item.existing.id);
  const pending = (h: string) => gidByHandle.get(h) ?? `gid://shopify/Collection/PENDING-${h}`;
  const children: NewMenuChild[] = [
    { title: "Déshumidificateurs", resourceId: pending("electro-deshumidificateurs"), after: "Climatisation & Ventilation" },
    { title: "Buanderie", resourceId: pending("electro-buanderie") },
  ];
  const mplan = planMenu(menu, ELECTRO_COLLECTION_GID, children);
  const tr = await countMenuEnTranslations(client, menu);
  console.log(`menu "${menu.title}" [${menu.handle}] — L1/L2/L3 = ${mplan.before.join("/")}  → ${mplan.after.join("/")} after`);
  console.log(`  existing items kept with their id: ${mplan.droppedIds.length === 0 ? "ALL" : `NO — would drop ${mplan.droppedIds.length}`}  |  EN titles today: ${tr.withEn}/${tr.total}`);
  const electro = mplan.input.find((i) => i.resourceId === ELECTRO_COLLECTION_GID);
  for (const k of electro?.items ?? []) console.log(`    ${k.id ? "  " : "+ "}${k.title}${k.id ? "" : "   ← NEW"}`);
  if (!mplan.changed) console.log("  → both entries already in the menu — nothing to do");
  console.log(
    APPLY && MENU
      ? "  (menu will be written in this run)"
      : "  (menu is NOT written: needs  --apply --menu ; do it when the pilot products go live)",
  );
  if (mplan.droppedIds.length) throw new Error("menu plan would drop existing items — aborting");

  if (!APPLY) {
    console.log("\nDRY-RUN — nothing written. Re-run with --apply (and --menu for step c).");
    return;
  }

  // ── APPLY ─────────────────────────────────────────────────────────────────────────────
  hr("APPLY a) rabais");
  const r = await applyRabais(client, rabais);
  console.log(`  ✓ rabais-2e-article excludes ${COSTWAY_TAG}; product count unchanged (${r.count})`);

  hr("APPLY b) collections");
  const created = await applyCollections(client, colPlan);
  for (const c of created) {
    gidByHandle.set(c.handle, c.gid);
    console.log(`  ✓ created ${c.handle} (id ${c.id}) published_at=${c.publishedAt ?? "null (unpublished)"}`);
    const spec = COLLECTION_SPECS.find((s) => s.handle === c.handle)!;
    const ok = await registerEnTitle(client, c.gid, spec.enTitle);
    console.log(`    EN title "${spec.enTitle}" ${ok ? "registered" : "NOT registered (no digest)"}`);
  }
  if (!created.length) console.log("  (all collections already existed)");

  if (MENU) {
    hr("APPLY c) menu");
    for (const h of ["electro-deshumidificateurs", "electro-buanderie"]) {
      if (!gidByHandle.get(h)) throw new Error(`collection ${h} missing — cannot link it in the menu`);
    }
    const real = planMenu(await fetchMenu(client, TAXONOMY_MENU_GID), ELECTRO_COLLECTION_GID, [
      { title: "Déshumidificateurs", resourceId: gidByHandle.get("electro-deshumidificateurs")!, after: "Climatisation & Ventilation" },
      { title: "Buanderie", resourceId: gidByHandle.get("electro-buanderie")! },
    ]);
    if (!real.changed) {
      console.log("  both entries already present — nothing to do");
    } else {
      const res = await applyMenu(client, real, { "Déshumidificateurs": "Dehumidifiers", Buanderie: "Laundry (washers & dryers)" });
      console.log(`  ✓ menu L1/L2/L3 ${res.before.join("/")} → ${res.after.join("/")}; EN titles ${res.translationsBefore.withEn}/${res.translationsBefore.total} → ${res.translationsAfter.withEn}/${res.translationsAfter.total}`);
      for (const n of res.newItems) console.log(`    + ${n.title} (${n.id}) EN ${n.enRegistered ? "registered" : "NOT registered"}`);
    }
  }
  console.log("\nDone.");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
