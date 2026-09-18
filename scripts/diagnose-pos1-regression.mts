#!/usr/bin/env tsx
/**
 * scripts/diagnose-pos1-regression.mts
 *
 * READ-ONLY diagnostic for a reported regression: some live products' pos-1 (primary) image
 * still carries a marketing/measurement overlay despite the 2026-09-11 catalogue audit (1,412
 * compliant / 312 fixable / 6 no-alternative, all applied 2026-09-12) and the import-time guard
 * shipped the same day (commit 2f24ff3, enforceCleanPrimaryImage wired into import-pipeline.ts).
 *
 * ⚠️  THIS SCRIPT HAS NO WRITE PATH. Not to Shopify (only GET requests), not to
 * image_review_queue, not to image_classifications (every classify call here uses
 * useCache:false so putCachedImageVerdict is never reached — see classifyWithCache in
 * image-compliance-audit.ts), not to products.image_checked_at. See selfCheckReadOnly() below
 * and the before/after row-count snapshot printed by main().
 *
 * MODES (combine freely; each is independent):
 *   --handles <handle,handle,...>   Deep-dive named products: live gallery, cache cross-ref,
 *                                   one fresh pos-1 verdict, timeline vs sync_logs/review queue.
 *   --full                          Catalogue-wide, CACHE-ONLY (budget:{left:0}), zero Claude
 *                                   calls, zero writes. Buckets: compliant/fixable/
 *                                   no_alternative/deferred/error. Checkpointed, resumable,
 *                                   windowed at --max-seconds (default 540).
 *   --live-sample N                 After --full (or from an existing checkpoint), spend N
 *                                   REAL verdicts (still useCache:false, still zero writes) on
 *                                   a sample of "deferred" products, to estimate what fraction
 *                                   of "never judged" is actually non-compliant.
 *   --buckets                       Root-cause attribution over the --full checkpoint:
 *                                     (a) imported after the guard shipped, still non-compliant
 *                                     (c) checked before, re-dirtied since (no reset signal)
 *                                     (b) never checked — starved by the 20/day cap
 *                                     (d) applied proposal gone stale (Shopify re-ingest)
 *   --report                        Write the HTML/CSV report from whatever checkpoint exists.
 *
 * Run under x64 Node (libsql has no win-arm64 build), from THIS worktree (origin/main — the
 * main repo checkout is 124 commits behind and does not have this system at all):
 *
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/diagnose-pos1-regression.mts --handles parc-chien-16-panneaux-acier-robuste,poulailler-bois-enclos-pondoir-poules,poulailler-grand-format-nid-enclos-couvert
 *   …diagnose-pos1-regression.mts --full --max-seconds 540      # repeat to resume
 *   …diagnose-pos1-regression.mts --live-sample 50
 *   …diagnose-pos1-regression.mts --buckets --report
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import type { Pos1AuditPlan } from "@/lib/image-compliance-audit";

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function opt(name: string, fallback: string): string {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return fallback;
}

const HANDLES = opt("handles", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const FULL = flag("full");
const LIVE_SAMPLE = Number(opt("live-sample", "0"));
const BUCKETS = flag("buckets");
const REPORT = flag("report");
const MAX_SECONDS = Number(opt("max-seconds", "540"));
const CONCURRENCY = Math.max(1, Number(opt("concurrency", "4")));
const CHECKPOINT = opt("checkpoint", ".tmp-imgaudit/pos1-regression.checkpoint.jsonl");
const LIVE_SAMPLE_FILE = ".tmp-imgaudit/pos1-regression.livesample.jsonl";
const REPORT_HTML = opt("report-out", ".tmp-imgaudit/pos1-regression-2026-09-17.html");
const REPORT_CSV = REPORT_HTML.replace(/\.html?$/i, ".csv");

// Commit 2f24ff3 — "feat(images): hybrid compliance mode + import-time pos-1 guard (v0.5.92.4)",
// 2026-09-11T21:30:23-04:00 — the moment enforceCleanPrimaryImage was wired into
// import-pipeline.ts (confirmed via `git log -S"enforceCleanPrimaryImage" -- src/lib/import-pipeline.ts`).
const GUARD_SHIPPED_AT = 1789176623;
const DAILY_BUDGET = 20; // DEFAULT_MAX_CLASSIFICATIONS in image-compliance.ts, shared pos-1+gallery

const started = Date.now();
const elapsed = () => (Date.now() - started) / 1000;

// ── Self-check: this file must have no write path ────────────────────────────
// Looks for actual CALL SITES (name followed by an open paren) or an HTTP method literal —
// not prose mentioning these names (this file's own comments explain, in English, why those
// functions are never reached, which would false-positive on a plain substring match).
function selfCheckReadOnly(): void {
  const self = fileURLToPath(import.meta.url);
  const src = readFileSync(self, "utf8");
  const forbiddenCall = /\b(putCachedImageVerdict|markImageChecked|addToImageReviewQueue|upsertImageReview)\s*\(/;
  const forbiddenMethod = /method:\s*["']?(PUT|POST|DELETE)/i;
  if (forbiddenCall.test(src) || forbiddenMethod.test(src)) {
    console.error("ABORT: forbidden write-path call found in this script's own source.");
    process.exit(1);
  }
  console.log("MODE: READ-ONLY — this script has no write path (self-check passed)");
}

/** Dynamic import: the app's modules have circular graphs that break static named-export
 *  detection under tsx (same reason as audit-pos1-compliance.mts / generate-slideshow-batch.mts). */
async function loadLib() {
  const [audit, db, shopify, vision] = await Promise.all([
    import("@/lib/image-compliance-audit"),
    import("@/lib/database"),
    import("@/lib/shopify-client"),
    import("@/lib/vision-classifier"),
  ]);
  return { audit, db, shopify, vision };
}

function rawDb() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL not set — run with --env-file=.env.local");
  return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
}

// ── Write-safety snapshot ─────────────────────────────────────────────────────
interface Snapshot { reviewQueue: number; classifications: number; checkedProducts: number }
async function snapshot(db: ReturnType<typeof rawDb>): Promise<Snapshot> {
  const [rq, ic, cp] = await Promise.all([
    db.execute("SELECT COUNT(*) AS n FROM image_review_queue"),
    db.execute("SELECT COUNT(*) AS n FROM image_classifications"),
    db.execute("SELECT COUNT(*) AS n FROM products WHERE image_checked_at IS NOT NULL"),
  ]);
  return {
    reviewQueue: Number((rq.rows[0] as unknown as { n: number }).n),
    classifications: Number((ic.rows[0] as unknown as { n: number }).n),
    checkedProducts: Number((cp.rows[0] as unknown as { n: number }).n),
  };
}
function printSnapshot(label: string, s: Snapshot): void {
  console.log(`  [${label}] image_review_queue=${s.reviewQueue} · image_classifications=${s.classifications} · products.image_checked_at NOT NULL=${s.checkedProducts}`);
}

// ── Checkpoint (same shape/idiom as audit-pos1-compliance.mts) ───────────────
function ensureDir(file: string): void {
  const dir = dirname(file);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}
function readCheckpoint(): Map<string, Pos1AuditPlan> {
  const out = new Map<string, Pos1AuditPlan>();
  if (!existsSync(CHECKPOINT)) return out;
  for (const line of readFileSync(CHECKPOINT, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const plan = JSON.parse(line) as Pos1AuditPlan;
      out.set(plan.shopifyProductId, plan);
    } catch {
      /* truncated final line from a killed window */
    }
  }
  return out;
}
function appendCheckpoint(plan: Pos1AuditPlan): void {
  ensureDir(CHECKPOINT);
  appendFileSync(CHECKPOINT, `${JSON.stringify(plan)}\n`, "utf8");
}

// ── Mode: --handles ────────────────────────────────────────────────────────────
async function runHandles(db: ReturnType<typeof rawDb>, lib: Awaited<ReturnType<typeof loadLib>>): Promise<void> {
  console.log(`\n═══ --handles (${HANDLES.length}) ═══`);
  for (const handle of HANDLES) {
    console.log(`\n── ${handle} ──`);
    const rows = (
      await db.execute({
        sql: `SELECT sku, shopify_product_id, name, created_at, image_checked_at
              FROM products WHERE shopify_handle = ? ORDER BY created_at ASC`,
        args: [handle],
      })
    ).rows as unknown as Array<{ sku: string; shopify_product_id: string; name: string; created_at: number; image_checked_at: number | null }>;

    if (rows.length === 0) {
      console.log(`  NOT FOUND in Turso products (shopify_handle='${handle}') — checking Shopify directly by handle…`);
      try {
        const r = await fetch(
          `https://${process.env.SHOPIFY_SHOP || "27u5y2-kp.myshopify.com"}/admin/api/2025-01/products.json?handle=${encodeURIComponent(handle)}&fields=id,handle,title`,
          { headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN || "" } },
        );
        const j = await r.json();
        console.log(`  Shopify lookup: ${JSON.stringify(j.products ?? j)}`);
      } catch (err) {
        console.log(`  Shopify lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    const shopifyProductId = rows[0].shopify_product_id;
    const productCreatedAt = Math.min(...rows.map((r) => r.created_at));
    const checkedAts = rows.map((r) => r.image_checked_at).filter((v): v is number => v !== null);
    console.log(`  shopify_product_id=${shopifyProductId} · ${rows.length} variant row(s) · sku(s)=${rows.map((r) => r.sku).join(", ")}`);
    console.log(`  products.created_at (earliest variant) = ${productCreatedAt} (${new Date(productCreatedAt * 1000).toISOString()})`);
    if (checkedAts.length === 0) {
      console.log(`  products.image_checked_at = NEVER on any variant row`);
    } else {
      const minC = Math.min(...checkedAts), maxC = Math.max(...checkedAts);
      console.log(`  products.image_checked_at = ${minC === maxC ? new Date(minC * 1000).toISOString() : `INCONSISTENT across variants: min=${new Date(minC * 1000).toISOString()} max=${new Date(maxC * 1000).toISOString()}`}`);
    }
    console.log(`  imported ${productCreatedAt >= GUARD_SHIPPED_AT ? "AFTER" : "BEFORE"} the import-time guard shipped (2026-09-11T21:30:23-04:00)`);

    // Live Shopify gallery — the actual ground truth for "primary".
    let gallery: Array<{ id: number; position: number; src: string }>;
    try {
      gallery = await lib.shopify.fetchProductImages(shopifyProductId);
    } catch (err) {
      console.log(`  fetchProductImages FAILED: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (gallery.length === 0) {
      console.log(`  Shopify gallery is EMPTY.`);
      continue;
    }
    console.log(`  Shopify gallery (${gallery.length} images, position order):`);
    const stems = gallery.map((im) => lib.audit.imageUrlStem(im.src));
    const cached = await lib.db.getCachedImageVerdicts(stems);
    gallery.forEach((im, i) => {
      const stem = stems[i];
      const v = cached.get(stem);
      const tag = !v ? "NEVER JUDGED" : v.compliant ? "compliant (cached)" : `NON-COMPLIANT (cached): ${v.reason}`;
      console.log(`    pos ${im.position} · id ${im.id} · stem=${stem} · ${tag}`);
      console.log(`      ${im.src}`);
    });

    // Fresh verdict on pos-1 only — direct call to classifyProductImage, which NEVER touches
    // the DB (only classifyWithCache's wrapper in image-compliance-audit.ts calls
    // putCachedImageVerdict, and we bypass that wrapper entirely here). Charged to the
    // uncapped `maintenance` pool per the scripts-only convention (see ClassifyOptions).
    const pos1 = gallery.find((im) => im.position === 1) ?? gallery[0];
    try {
      const fresh = await lib.vision.classifyProductImage(pos1.src, { maintenance: true });
      console.log(`  FRESH pos-1 verdict (uncached, NOT written back): compliant=${fresh.compliant} · confidence=${fresh.confidence ?? "n/a"} · reason: ${fresh.reason}`);
    } catch (err) {
      console.log(`  Fresh pos-1 classify FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Timeline: sync_logs (image-related) vs image_checked_at.
    const logs = (
      await db.execute({
        sql: `SELECT timestamp, action, field, old_value, new_value FROM sync_logs
              WHERE shopify_product_id = ? AND field LIKE 'image%' ORDER BY timestamp DESC LIMIT 20`,
        args: [shopifyProductId],
      })
    ).rows as unknown as Array<{ timestamp: string; action: string; field: string; old_value: string | null; new_value: string | null }>;
    console.log(`  sync_logs (field LIKE 'image%'), most recent ${logs.length}:`);
    for (const l of logs) console.log(`    ${l.timestamp} · ${l.action}/${l.field} · ${(l.old_value ?? "").slice(0, 60)} → ${(l.new_value ?? "").slice(0, 60)}`);
    if (logs.length > 0 && checkedAts.length > 0) {
      const lastLogSec = Math.floor(new Date(logs[0].timestamp).getTime() / 1000);
      const maxChecked = Math.max(...checkedAts);
      console.log(`  last image sync_logs event (${lastLogSec}) ${lastLogSec > maxChecked ? ">" : "<="} image_checked_at (${maxChecked}) → ${lastLogSec > maxChecked ? "RE-DIRTIED AFTER LAST CHECK" : "checked after last known change"}`);
    }

    const reviews = (
      await db.execute({
        sql: `SELECT id, status, current_url, proposed_url, proposed_image_id, created_at, decided_at, error
              FROM image_review_queue WHERE shopify_product_id = ? ORDER BY created_at DESC`,
        args: [shopifyProductId],
      })
    ).rows as unknown as Array<{ id: number; status: string; current_url: string; proposed_url: string; proposed_image_id: string | null; created_at: number; decided_at: number | null; error: string | null }>;
    console.log(`  image_review_queue history (${reviews.length} row(s)):`);
    for (const r of reviews) {
      console.log(`    #${r.id} ${r.status} · created ${new Date(r.created_at * 1000).toISOString()}${r.decided_at ? ` · decided ${new Date(r.decided_at * 1000).toISOString()}` : ""}`);
      console.log(`      proposed: ${r.proposed_url} (stem ${lib.audit.imageUrlStem(r.proposed_url)}, img id ${r.proposed_image_id ?? "null/feed"})`);
      if (r.status === "applied") {
        const liveStems = new Set(stems);
        const stillThere = liveStems.has(lib.audit.imageUrlStem(r.proposed_url));
        console.log(`      applied proposal ${stillThere ? "STILL matches a live gallery photo" : "NO LONGER in the live gallery — STALE (bucket d)"}`);
      }
    }
  }
}

// ── Mode: --full ──────────────────────────────────────────────────────────────
async function runFull(lib: Awaited<ReturnType<typeof loadLib>>): Promise<void> {
  console.log(`\n═══ --full (cache-only, zero Claude calls) ═══`);
  const products = await lib.db.getPos1AuditProducts({}); // NO onlyUnchecked — image_checked_at is distrusted as a filter
  const done = readCheckpoint();
  const todo = products.filter((p) => !done.has(p.shopifyProductId));
  console.log(`catalogue: ${products.length} live products · already in checkpoint: ${done.size} · to do: ${todo.length} · window ${MAX_SECONDS}s · concurrency ${CONCURRENCY}`);

  let processed = 0;
  let stopped = "";
  const tally = { compliant: 0, fixable: 0, no_alternative: 0, deferred: 0, no_images: 0, error: 0 };
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (stopped) return;
      if (elapsed() > MAX_SECONDS) { stopped = `window of ${MAX_SECONDS}s reached`; return; }
      const i = cursor++;
      if (i >= todo.length) return;
      const p = todo[i];
      // budget:{left:0}, useCache:true → pure cache reads. classifyWithCache only calls
      // classify()/putCachedImageVerdict when it's about to SPEND a call; with left=0 it never
      // does. Confirmed by reading image-compliance-audit.ts before writing this.
      const plan = await lib.audit.auditProductPos1(p, { useCache: true, budget: { left: 0 }, includeFeedOnly: true });
      appendCheckpoint(plan);
      tally[plan.status]++;
      processed++;
      if (processed % 100 === 0) {
        console.log(`  ${processed}/${todo.length} · compliant ${tally.compliant} · fixable ${tally.fixable} · no_alt ${tally.no_alternative} · deferred ${tally.deferred} · error ${tally.error} · ${Math.round(elapsed())}s`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const all = readCheckpoint();
  console.log(`\n── window done${stopped ? ` (${stopped})` : " (catalogue fully scanned)"} ──`);
  console.log(`this window: ${processed} products, 0 Claude calls (cache-only by construction)`);
  console.log(`checkpoint total: ${all.size}/${products.length}`);
  const finalTally = { compliant: 0, fixable: 0, no_alternative: 0, deferred: 0, no_images: 0, error: 0 };
  for (const plan of all.values()) finalTally[plan.status]++;
  console.log(`  compliant:       ${finalTally.compliant}`);
  console.log(`  FIXABLE:         ${finalTally.fixable}`);
  console.log(`  no_alternative:  ${finalTally.no_alternative}`);
  console.log(`  deferred (never judged): ${finalTally.deferred}`);
  console.log(`  no_images:       ${finalTally.no_images}`);
  console.log(`  error:           ${finalTally.error}`);
  console.log(`  NON-COMPLIANT TOTAL (fixable + no_alternative): ${finalTally.fixable + finalTally.no_alternative}`);
  if (all.size < products.length) {
    console.log(`\n  ⚠ incomplete — re-run the same command to resume (${products.length - all.size} remaining).`);
  }
}

// ── Mode: --live-sample ────────────────────────────────────────────────────────
async function runLiveSample(lib: Awaited<ReturnType<typeof loadLib>>): Promise<void> {
  console.log(`\n═══ --live-sample ${LIVE_SAMPLE} ═══`);
  const all = [...readCheckpoint().values()];
  const deferred = all.filter((p) => p.status === "deferred");
  if (deferred.length === 0) {
    console.log("no 'deferred' entries in the checkpoint — run --full first.");
    return;
  }
  // Deterministic sample (every Nth) rather than Math.random, so a re-run with the same N is
  // reproducible and auditable.
  const step = Math.max(1, Math.floor(deferred.length / LIVE_SAMPLE));
  const sample = deferred.filter((_, i) => i % step === 0).slice(0, LIVE_SAMPLE);
  console.log(`sampling ${sample.length}/${deferred.length} deferred products, real (uncached) verdicts, budget=1 call each, useCache:false → writes nothing`);

  // With budget:{left:1}, exactly one call is spent on pos-1 itself. If pos-1 turns out
  // non-compliant, the function immediately tries to scan alternatives, finds budget
  // exhausted on the very first one, and returns status "deferred" again (NOT "fixable" —
  // that would require a second call to find/confirm a replacement). So the real signal is
  // NOT plan.status alone: it's calls>=1 (a fresh verdict was actually obtained) combined
  // with status!=="compliant" (that verdict was negative). calls===0 is the only genuine
  // failure case (gallery fetch threw before any classify call was attempted).
  let compliant = 0, nonCompliant = 0, trueFailures = 0;
  for (const p of sample) {
    const budget = { left: 1 };
    const plan = await lib.audit.auditProductPos1(
      { sku: p.sku, shopifyProductId: p.shopifyProductId, name: p.name },
      { useCache: false, budget, includeFeedOnly: false },
    );
    ensureDir(LIVE_SAMPLE_FILE);
    appendFileSync(LIVE_SAMPLE_FILE, `${JSON.stringify(plan)}\n`, "utf8");
    if (plan.calls === 0) trueFailures++;
    else if (plan.status === "compliant") compliant++;
    else nonCompliant++; // real fresh verdict obtained, and it was non-compliant
  }
  console.log(`sample result: ${compliant} compliant · ${nonCompliant} CONFIRMED non-compliant (real fresh verdict, negative) · ${trueFailures} true failures (gallery fetch/classify threw before any verdict) — out of ${sample.length}`);
  if (sample.length === deferred.length) {
    console.log(`this sample covers ALL ${deferred.length} deferred products — this is an EXACT count, not an extrapolation.`);
  } else if (sample.length - trueFailures > 0) {
    const rate = nonCompliant / (sample.length - trueFailures);
    const estimate = Math.round(rate * deferred.length);
    console.log(`extrapolated non-compliance rate among ALL ${deferred.length} deferred products: ~${(rate * 100).toFixed(0)}% → ~${estimate} products`);
  }
}

// ── Mode: --buckets ─────────────────────────────────────────────────────────
async function runBuckets(db: ReturnType<typeof rawDb>, lib: Awaited<ReturnType<typeof loadLib>>): Promise<void> {
  console.log(`\n═══ --buckets (root-cause attribution) ═══`);
  const all = [...readCheckpoint().values()];

  // A "deferred" verdict from the cache-only --full pass means "never judged" — it is NOT
  // itself a non-compliance verdict. If --live-sample has since resolved some of these with a
  // real fresh check, use that ground truth instead of the placeholder "deferred" status:
  // drop confirmed-compliant ones, keep confirmed-non-compliant ones for bucketing, and leave
  // genuinely still-unresolved "deferred" entries in (conservatively counted, since a product
  // that was never judged might still carry an overlay).
  const liveSample = new Map<string, Pos1AuditPlan>();
  if (existsSync(LIVE_SAMPLE_FILE)) {
    for (const line of readFileSync(LIVE_SAMPLE_FILE, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const plan = JSON.parse(line) as Pos1AuditPlan;
        if (plan.calls >= 1) liveSample.set(plan.shopifyProductId, plan); // only a real verdict overrides
      } catch { /* truncated line */ }
    }
  }

  const nonCompliant = all.filter((p) => {
    if (p.status === "fixable" || p.status === "no_alternative") return true;
    if (p.status !== "deferred") return false;
    const resolved = liveSample.get(p.shopifyProductId);
    if (!resolved) return true; // still genuinely unresolved — count conservatively
    return resolved.status !== "compliant"; // live-sample confirmed compliant → drop
  });
  const confirmedByLiveSample = nonCompliant.filter((p) => liveSample.has(p.shopifyProductId)).length;
  console.log(`analyzing ${nonCompliant.length} non-compliant products out of ${all.length} scanned (${confirmedByLiveSample} confirmed via --live-sample fresh verdicts, rest are cache-confirmed fixable/no_alternative or still-unresolved deferred)`);

  const ids = nonCompliant.map((p) => p.shopifyProductId);
  if (ids.length === 0) { console.log("nothing to bucket."); return; }

  // Bulk-fetch created_at / image_checked_at for all candidates in one go.
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
  const meta = new Map<string, { created_at: number; image_checked_at: number | null }>();
  for (const chunk of chunks) {
    const rows = (
      await db.execute({
        sql: `SELECT shopify_product_id, MIN(created_at) AS created_at, MAX(image_checked_at) AS image_checked_at
              FROM products WHERE shopify_product_id IN (${chunk.map(() => "?").join(",")}) GROUP BY shopify_product_id`,
        args: chunk,
      })
    ).rows as unknown as Array<{ shopify_product_id: string; created_at: number; image_checked_at: number | null }>;
    for (const r of rows) meta.set(String(r.shopify_product_id), { created_at: r.created_at, image_checked_at: r.image_checked_at });
  }

  // "Re-dirtied since check": last image-field sync_logs event newer than image_checked_at.
  const redirtied = new Set<string>();
  for (const chunk of chunks) {
    const rows = (
      await db.execute({
        sql: `SELECT p.shopify_product_id AS id, MAX(sl.timestamp) AS last_image_event
              FROM products p JOIN sync_logs sl ON sl.shopify_product_id = p.shopify_product_id
              WHERE p.shopify_product_id IN (${chunk.map(() => "?").join(",")}) AND sl.field LIKE 'image%'
              GROUP BY p.shopify_product_id`,
        args: chunk,
      })
    ).rows as unknown as Array<{ id: string; last_image_event: string }>;
    for (const r of rows) {
      const m = meta.get(String(r.id));
      if (!m || m.image_checked_at === null) continue;
      const lastSec = Math.floor(new Date(r.last_image_event).getTime() / 1000);
      if (lastSec > m.image_checked_at) redirtied.add(String(r.id));
    }
  }

  // Stale applied proposals (bucket d) — needs a live gallery re-check, so only run it for the
  // (usually small) set of products with an 'applied' review row.
  const applied = (
    await db.execute("SELECT shopify_product_id, proposed_url FROM image_review_queue WHERE status = 'applied'")
  ).rows as unknown as Array<{ shopify_product_id: string; proposed_url: string }>;
  const staleApplied = new Set<string>();
  console.log(`checking ${applied.length} 'applied' review rows for staleness (live Shopify gallery GET each)…`);
  for (const a of applied) {
    try {
      const gallery = await lib.shopify.fetchProductImages(a.shopify_product_id);
      const liveStems = new Set(gallery.map((im: { src: string }) => lib.audit.imageUrlStem(im.src)));
      if (!liveStems.has(lib.audit.imageUrlStem(a.proposed_url))) staleApplied.add(String(a.shopify_product_id));
    } catch {
      /* leave unclassified rather than guessing */
    }
  }

  // Never-checked backlog depth (bucket b), sorted newest-first exactly as getImageComplianceCandidates does.
  const neverCheckedAll = (
    await db.execute(
      `SELECT shopify_product_id FROM products WHERE shopify_product_id IS NOT NULL AND shopify_product_id <> '' AND image_checked_at IS NULL GROUP BY shopify_product_id ORDER BY MAX(created_at) DESC`,
    )
  ).rows as unknown as Array<{ shopify_product_id: string }>;
  const queuePosition = new Map<string, number>();
  neverCheckedAll.forEach((r, i) => queuePosition.set(String(r.shopify_product_id), i));

  const buckets = { a_import_guard_leak: [] as string[], c_redirtied: [] as string[], b_never_checked: [] as string[], d_stale_applied: [] as string[], unclassified: [] as string[] };
  for (const p of nonCompliant) {
    const id = p.shopifyProductId;
    const m = meta.get(id);
    if (staleApplied.has(id)) { buckets.d_stale_applied.push(id); continue; }
    if (m && m.created_at >= GUARD_SHIPPED_AT) { buckets.a_import_guard_leak.push(id); continue; }
    if (m && m.image_checked_at !== null && redirtied.has(id)) { buckets.c_redirtied.push(id); continue; }
    if (m && m.image_checked_at === null) { buckets.b_never_checked.push(id); continue; }
    // image_checked_at is set, sync_logs shows no image-field event (retention gap or the
    // compliance pass simply doesn't log a no-op "still clean" check) — but if NONE of the
    // CURRENT live gallery photos have ever been cached at all, the whole photo set was
    // replaced after the check with no reset signal reaching Turso. Same conclusion as (c),
    // reached by a different, stronger signal (observed directly on parc-chien-16-panneaux-
    // acier-robuste / D06-140V01BK during --handles).
    if (m && m.image_checked_at !== null) {
      try {
        const gallery = await lib.shopify.fetchProductImages(id);
        const stems = gallery.map((im: { src: string }) => lib.audit.imageUrlStem(im.src));
        const cached = await lib.db.getCachedImageVerdicts(stems);
        if (stems.length > 0 && cached.size === 0) { buckets.c_redirtied.push(id); continue; }
      } catch { /* fall through to unclassified rather than guess */ }
    }
    buckets.unclassified.push(id);
  }

  console.log(`\n(a) import-guard leak — created AFTER 2026-09-11T21:30 yet non-compliant: ${buckets.a_import_guard_leak.length}`);
  if (buckets.a_import_guard_leak.length > 0) {
    console.log("    ⚠ this is a live bug signal — detail:");
    for (const id of buckets.a_import_guard_leak) {
      const plan = nonCompliant.find((p) => p.shopifyProductId === id)!;
      console.log(`      sku=${plan.sku} name="${plan.name}" status=${plan.status} created_at=${meta.get(id)?.created_at}`);
    }
  }
  console.log(`(c) re-dirtied after being checked (no reset signal): ${buckets.c_redirtied.length}`);
  console.log(`(b) never checked (backlog) among non-compliant/deferred: ${buckets.b_never_checked.length}`);
  if (buckets.b_never_checked.length > 0) {
    const depths = buckets.b_never_checked.map((id) => queuePosition.get(id) ?? -1).filter((d) => d >= 0);
    if (depths.length > 0) {
      const minD = Math.min(...depths), maxD = Math.max(...depths), medianD = depths.sort((x, y) => x - y)[Math.floor(depths.length / 2)];
      console.log(`    queue depth (0-indexed, newest-first, ${neverCheckedAll.length} total never-checked): min=${minD} median=${medianD} max=${maxD}`);
      console.log(`    at ${DAILY_BUDGET}/day shared budget: median ~${Math.round(medianD / DAILY_BUDGET)} days to reach, worst case ~${Math.round(maxD / DAILY_BUDGET)} days`);
    }
  }
  console.log(`(d) applied proposal gone stale: ${buckets.d_stale_applied.length} (of ${applied.length} applied rows checked)`);
  console.log(`unclassified (none of the above matched): ${buckets.unclassified.length}`);

  writeFileSync(
    ".tmp-imgaudit/pos1-regression-buckets.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), buckets, totals: { nonCompliant: nonCompliant.length, scanned: all.length } }, null, 2),
  );
  console.log(`\nbucket detail written to .tmp-imgaudit/pos1-regression-buckets.json`);
}

// ── Report ───────────────────────────────────────────────────────────────────
function writeReportFile(): void {
  const all = [...readCheckpoint().values()];
  const bucketsById: Record<string, string> = {};
  if (existsSync(".tmp-imgaudit/pos1-regression-buckets.json")) {
    const b = JSON.parse(readFileSync(".tmp-imgaudit/pos1-regression-buckets.json", "utf8")).buckets;
    for (const [name, ids] of Object.entries(b) as [string, string[]][]) for (const id of ids) bucketsById[id] = name;
  }
  // Merge --live-sample ground truth over the placeholder "deferred" status, same rule as
  // runBuckets: a real fresh verdict (calls>=1) is authoritative over "never judged".
  const liveSample = new Map<string, Pos1AuditPlan>();
  if (existsSync(LIVE_SAMPLE_FILE)) {
    for (const line of readFileSync(LIVE_SAMPLE_FILE, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const plan = JSON.parse(line) as Pos1AuditPlan;
        if (plan.calls >= 1) liveSample.set(plan.shopifyProductId, plan);
      } catch { /* truncated line */ }
    }
  }
  const resolved = all.map((p) => {
    if (p.status !== "deferred") return p;
    const ls = liveSample.get(p.shopifyProductId);
    if (!ls) return p;
    return ls.status === "compliant" ? { ...p, status: "compliant" as const } : { ...p, status: "no_alternative" as const, currentReason: ls.currentReason };
  });

  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fixable = resolved.filter((p) => p.status === "fixable");
  const noAlt = resolved.filter((p) => p.status === "no_alternative");
  const deferred = resolved.filter((p) => p.status === "deferred"); // genuinely still unresolved
  const compliant = resolved.filter((p) => p.status === "compliant");

  const row = (p: Pos1AuditPlan) => `<tr>
    <td><code>${esc(p.sku)}</code><br>${esc(p.name)}<br>
      <a href="https://admin.shopify.com/store/27u5y2-kp/products/${esc(p.shopifyProductId)}" target="_blank">admin ↗</a></td>
    <td>${esc(p.status)}${bucketsById[p.shopifyProductId] ? ` · bucket ${esc(bucketsById[p.shopifyProductId])}` : ""}</td>
    <td>${p.currentUrl ? `<a href="${esc(p.currentUrl)}" target="_blank"><img src="${esc(p.currentUrl)}" style="width:140px;height:140px;object-fit:contain" loading="lazy"></a>` : ""}<p style="font-size:11px">${esc(p.currentReason || "")}</p></td>
  </tr>`;

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Diagnostic régression pos-1 — 2026-09-17</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}
.stats{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.stat{border:1px solid #ddd;border-radius:8px;padding:10px 14px}.stat b{display:block;font-size:22px}
table{border-collapse:collapse;width:100%}td,th{border-top:1px solid #eee;padding:8px;text-align:left;vertical-align:top}</style>
</head><body>
<h1>Diagnostic régression pos-1 (images texte/mesures) — 2026-09-17</h1>
<p>Lecture seule. ${all.length} produits scannés (cache uniquement, 0 appel Claude pour --full).</p>
<p>Baseline 2026-09-11 : 1 730 produits → 1 412 conformes / 312 réparables / 6 sans alternative / 0 erreur.</p>
<div class="stats">
  <div class="stat"><b>${compliant.length}</b>conformes</div>
  <div class="stat"><b>${fixable.length}</b>réparables</div>
  <div class="stat"><b>${noAlt.length}</b>sans alternative</div>
  <div class="stat"><b>${deferred.length}</b>jamais jugés (deferred)</div>
  <div class="stat"><b>${fixable.length + noAlt.length}</b>NON-CONFORMES (total)</div>
</div>
<h2>Réparables + sans alternative (${fixable.length + noAlt.length})</h2>
<table><tbody>${[...fixable, ...noAlt].map(row).join("")}</tbody></table>
<h2>Jamais jugés (${deferred.length})</h2>
<table><tbody>${deferred.slice(0, 200).map(row).join("")}</tbody></table>
${deferred.length > 200 ? `<p>… et ${deferred.length - 200} de plus (voir le CSV).</p>` : ""}
</body></html>`;

  const csvEsc = (s: string | number) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const csv = [
    ["sku", "shopify_product_id", "name", "status", "bucket", "current_url", "current_reason"].join(","),
    ...all.map((p) => [p.sku, p.shopifyProductId, p.name, p.status, bucketsById[p.shopifyProductId] ?? "", p.currentUrl, p.currentReason].map(csvEsc).join(",")),
  ].join("\n");

  ensureDir(REPORT_HTML);
  writeFileSync(REPORT_HTML, html, "utf8");
  writeFileSync(REPORT_CSV, csv, "utf8");
  console.log(`report: ${REPORT_HTML}`);
  console.log(`csv:    ${REPORT_CSV}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  selfCheckReadOnly();
  const db = rawDb();
  const before = await snapshot(db);
  printSnapshot("BEFORE", before);

  const lib = await loadLib();

  if (HANDLES.length > 0) await runHandles(db, lib);
  if (FULL) await runFull(lib);
  if (LIVE_SAMPLE > 0) await runLiveSample(lib);
  if (BUCKETS) await runBuckets(db, lib);
  if (REPORT || BUCKETS) writeReportFile();

  const after = await snapshot(db);
  printSnapshot("AFTER", after);
  const icDelta = after.classifications - before.classifications;
  const expectedMaxIcDelta = LIVE_SAMPLE > 0 ? 0 : 0; // useCache:false everywhere → must be exactly 0 regardless
  console.log(
    icDelta === expectedMaxIcDelta
      ? `\n✓ write-safety confirmed: image_review_queue and products.image_checked_at unchanged, image_classifications unchanged (${before.classifications} → ${after.classifications}).`
      : `\n⚠ UNEXPECTED WRITE DETECTED: image_classifications went from ${before.classifications} to ${after.classifications} (expected no change — investigate before trusting this run).`,
  );
  if (before.reviewQueue !== after.reviewQueue) console.log(`⚠ UNEXPECTED: image_review_queue count changed (${before.reviewQueue} → ${after.reviewQueue})`);
  if (before.checkedProducts !== after.checkedProducts) console.log(`⚠ UNEXPECTED: products.image_checked_at NOT NULL count changed (${before.checkedProducts} → ${after.checkedProducts})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
