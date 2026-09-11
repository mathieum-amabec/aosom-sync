#!/usr/bin/env tsx
/**
 * scripts/audit-pos1-compliance.mts
 *
 * Catalog-wide DRY-RUN audit of every live product's pos-1 (featured) image.
 *
 * For each product it asks Claude Vision whether the current primary image carries a
 * marketing/measurement overlay (dimension callouts, arrows, slogans, badges) and, when it
 * does, proposes the first clean alternative from the SAME image set — the Shopify gallery
 * plus any Aosom feed photo absent from it.
 *
 * ⚠️  WRITES NOTHING TO SHOPIFY. Ever. Not even with --apply (there is no --apply). The only
 * writes are to Turso: the `image_classifications` verdict cache, and — with --queue — the
 * `image_review_queue` rows awaiting operator approval in /images.
 *
 * EXTENSION: `.mts` because it imports the project's TypeScript engine (the same
 * image-compliance-audit module the daily sync guard uses, so the audit and the guard can
 * never disagree). `.mts` is also covered by tsconfig, so `tsc --noEmit` type-checks it —
 * `.mjs` is not, and an untyped script has broken the Vercel build before.
 *
 * Run under x64 Node (libsql has no win-arm64 build), with prod creds, through tsx:
 *
 *   # audit everything, resuming from the checkpoint (default):
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/audit-pos1-compliance.mts
 *   # cap the work for a first look:
 *   …audit-pos1-compliance.mts --limit 25 --max-calls 60
 *   # only products the daily guard has never classified:
 *   …audit-pos1-compliance.mts --only-unchecked
 *   # also enqueue every fixable product for approval in /images:
 *   …audit-pos1-compliance.mts --queue
 *   # regenerate the HTML/CSV report from the checkpoint, spending nothing:
 *   …audit-pos1-compliance.mts --report-only
 *
 * WINDOWING: background shells die at ~5 min, so long runs go in FOREGROUND windows of
 * ≤9.5 min via --max-seconds (default 540). The JSONL checkpoint is append-only and keyed by
 * Shopify product id, so re-running simply resumes. The verdict cache means a resumed run
 * re-pays nothing for images already judged.
 *
 * FLAGS accept both `--name value` and `--name=value`.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

const CHECKPOINT = opt("checkpoint", ".tmp-imgaudit/pos1-audit.checkpoint.jsonl");
const REPORT_HTML = opt("report", ".tmp-imgaudit/pos1-audit-report.html");
const REPORT_CSV = REPORT_HTML.replace(/\.html?$/i, ".csv");
const LIMIT = Number(opt("limit", "0"));
const MAX_CALLS = Number(opt("max-calls", "0"));
const MAX_SECONDS = Number(opt("max-seconds", "540"));
// 4 keeps the Anthropic call rate under the burst ceiling: at 6 the tail of a 9-minute
// window degenerated into a run of 429s that surfaced as ~47 "classification failed".
const CONCURRENCY = Math.max(1, Number(opt("concurrency", "4")));
/** Max checkpoint writes per product before a persistent "error" stops being retried. */
const MAX_ATTEMPTS = Math.max(1, Number(opt("max-attempts", "3")));
const ONLY_UNCHECKED = flag("only-unchecked");
const QUEUE = flag("queue");
const REPORT_ONLY = flag("report-only");
const NO_FEED = flag("no-feed");
// Image size drives cost: ~952 tokens/call at 512px vs ~1961 at 1024px. Validated at 97.9%
// agreement with 1024px over 48 images; the one divergence was a MISSED overlay (small
// print), i.e. the safe direction — a fix is skipped, never a bad swap proposed.
const PX = Math.max(64, Number(opt("px", "512")));
// Default: charge the audit to the uncapped `maintenance` pool. --in-pool puts it back on
// the shared `batch` cap, where a full pass would consume ~2 days of production budget.
const OFF_POOL = !flag("in-pool");

const started = Date.now();
const elapsed = () => (Date.now() - started) / 1000;

/** Dynamic import: the app's modules have circular graphs that break static named-export
 *  detection under tsx (same reason as generate-slideshow-batch.mts). */
async function loadLib() {
  const [audit, db] = await Promise.all([
    import("@/lib/image-compliance-audit"),
    import("@/lib/database"),
  ]);
  return { audit, db };
}

// ── Checkpoint ───────────────────────────────────────────────────────────────
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
      // Last write wins: a resumed run that re-audits a product supersedes the old verdict.
      out.set(plan.shopifyProductId, plan);
    } catch {
      // A truncated final line from a killed window — ignore it.
    }
  }
  return out;
}

/** How many times each product has been written to the checkpoint — an "error" row that has
 *  been retried this many times stops being retried. */
function readAttempts(): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync(CHECKPOINT)) return out;
  for (const line of readFileSync(CHECKPOINT, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const id = (JSON.parse(line) as Pos1AuditPlan).shopifyProductId;
      out.set(id, (out.get(id) ?? 0) + 1);
    } catch {
      // truncated line
    }
  }
  return out;
}

function appendCheckpoint(plan: Pos1AuditPlan): void {
  ensureDir(CHECKPOINT);
  appendFileSync(CHECKPOINT, `${JSON.stringify(plan)}\n`, "utf8");
}

// ── Report ───────────────────────────────────────────────────────────────────
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Ask a Shopify CDN URL for a small thumbnail so the report page stays light. */
function thumb(url: string): string {
  if (!url.includes("/s/files/")) return url;
  const [path, query] = url.split("?");
  if (!/\.[a-zA-Z]+$/.test(path)) return url;
  const resized = path.replace(/(\.[a-zA-Z]+)$/, "_400x400$1");
  return query ? `${resized}?${query}` : resized;
}

function writeReport(plans: Pos1AuditPlan[]): { html: string; csv: string } {
  const fixable = plans.filter((p) => p.status === "fixable");
  const ambiguous = plans.filter((p) => p.status === "no_alternative" || p.status === "error" || p.status === "no_images" || p.status === "deferred");
  const compliant = plans.filter((p) => p.status === "compliant");

  const row = (p: Pos1AuditPlan): string => `
    <tr>
      <td class="sku"><code>${esc(p.sku)}</code><br><span class="name">${esc(p.name)}</span>
        <br><a href="https://admin.shopify.com/store/27u5y2-kp/products/${esc(p.shopifyProductId)}" target="_blank" rel="noreferrer">admin ↗</a></td>
      <td class="cell bad">
        <a href="${esc(p.currentUrl)}" target="_blank" rel="noreferrer"><img src="${esc(thumb(p.currentUrl))}" loading="lazy" alt=""></a>
        <p>${esc(p.currentReason)}</p>
      </td>
      <td class="arrow">→</td>
      <td class="cell good">
        ${p.proposedUrl ? `<a href="${esc(p.proposedUrl)}" target="_blank" rel="noreferrer"><img src="${esc(thumb(p.proposedUrl))}" loading="lazy" alt=""></a>` : "<div class='none'>aucune</div>"}
        <p>${esc(p.proposedReason ?? "")}</p>
        <span class="meta">${p.proposedSource === "feed" ? "flux Aosom (upload requis)" : `galerie Shopify · pos ${p.proposedPosition ?? "?"}`}</span>
      </td>
    </tr>`;

  const ambiguousRow = (p: Pos1AuditPlan): string => `
    <tr>
      <td class="sku"><code>${esc(p.sku)}</code><br><span class="name">${esc(p.name)}</span></td>
      <td><span class="tag t-${esc(p.status)}">${esc(p.status)}</span></td>
      <td class="cell">
        ${p.currentUrl ? `<a href="${esc(p.currentUrl)}" target="_blank" rel="noreferrer"><img src="${esc(thumb(p.currentUrl))}" loading="lazy" alt=""></a>` : ""}
        <p>${esc(p.currentReason || p.error || "")}</p>
        <span class="meta">${p.scanned}/${p.candidates} images examinées</span>
      </td>
    </tr>`;

  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Audit image pos-1 — dry-run</title>
<style>
  :root{--bg:#fff;--fg:#111;--mut:#666;--line:#e5e5e5;--bad:#c0392b;--good:#1e8449;}
  @media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--mut:#999;--line:#333;}}
  body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px;}
  h1{font-size:22px;margin:0 0 4px} h2{font-size:17px;margin:32px 0 8px}
  .sub{color:var(--mut);margin:0 0 20px}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
  .stat{border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:120px}
  .stat b{display:block;font-size:24px}
  table{border-collapse:collapse;width:100%;margin-bottom:20px}
  td,th{border-top:1px solid var(--line);padding:10px;vertical-align:top;text-align:left}
  img{width:190px;height:190px;object-fit:contain;background:#f6f6f6;border-radius:6px;display:block}
  .sku{width:210px} .name{color:var(--mut);font-size:12px}
  .cell p{font-size:12px;color:var(--mut);margin:6px 0 2px;max-width:230px}
  .meta{font-size:11px;color:var(--mut)}
  .arrow{font-size:22px;color:var(--mut);width:30px;text-align:center}
  .bad img{outline:2px solid var(--bad)} .good img{outline:2px solid var(--good)}
  .none{width:190px;height:190px;display:grid;place-items:center;border:1px dashed var(--line);border-radius:6px;color:var(--mut)}
  .tag{font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--line)}
</style></head><body>
<h1>Audit image principale (pos-1) — DRY-RUN</h1>
<p class="sub">Aucune écriture sur Shopify. Généré le ${new Date().toISOString()} · ${plans.length} produits audités.</p>
<div class="stats">
  <div class="stat"><b>${fixable.length}</b>corrigeables</div>
  <div class="stat"><b>${ambiguous.length}</b>ambigus / sans alternative</div>
  <div class="stat"><b>${compliant.length}</b>déjà conformes</div>
</div>
<h2>À corriger — ${fixable.length} produits</h2>
<table><thead><tr><th>Produit</th><th>Image actuelle (non conforme)</th><th></th><th>Remplacement proposé</th></tr></thead>
<tbody>${fixable.map(row).join("")}</tbody></table>
<h2>Cas ambigus — ${ambiguous.length} produits (inchangés)</h2>
<table><thead><tr><th>Produit</th><th>Statut</th><th>Image actuelle</th></tr></thead>
<tbody>${ambiguous.map(ambiguousRow).join("")}</tbody></table>
</body></html>`;

  const csvEsc = (s: string | number) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const csv = [
    ["sku", "shopify_product_id", "name", "status", "current_url", "current_reason", "proposed_url", "proposed_image_id", "proposed_position", "proposed_source", "proposed_reason", "scanned", "candidates"].join(","),
    ...plans.map((p) => [
      p.sku, p.shopifyProductId, p.name, p.status, p.currentUrl, p.currentReason,
      p.proposedUrl ?? "", p.proposedImageId ?? "", p.proposedPosition ?? "", p.proposedSource ?? "",
      p.proposedReason ?? "", p.scanned, p.candidates,
    ].map(csvEsc).join(",")),
  ].join("\n");

  ensureDir(REPORT_HTML);
  writeFileSync(REPORT_HTML, html, "utf8");
  writeFileSync(REPORT_CSV, csv, "utf8");
  return { html: REPORT_HTML, csv: REPORT_CSV };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { audit, db } = await loadLib();
  const done = readCheckpoint();

  if (REPORT_ONLY) {
    const plans = [...done.values()];
    const { html, csv } = writeReport(plans);
    console.log(`report-only: ${plans.length} produits → ${html} · ${csv}`);
    return;
  }

  const products = await db.getPos1AuditProducts({ onlyUnchecked: ONLY_UNCHECKED });
  // A checkpointed "error" is usually a rate-limit burst, not a broken product, so it stays
  // eligible for a later window — up to MAX_ATTEMPTS, after which it is left alone and shows
  // up in the ambiguous list rather than looping forever.
  const attempts = readAttempts();
  const pending = products.filter((p) => {
    const prev = done.get(p.shopifyProductId);
    if (!prev) return true;
    return prev.status === "error" && (attempts.get(p.shopifyProductId) ?? 0) < MAX_ATTEMPTS;
  });
  const todo = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;

  console.log(
    `catalogue: ${products.length} produits live · déjà audités: ${done.size} · à faire: ${pending.length}` +
    `${LIMIT > 0 ? ` (fenêtre: ${todo.length})` : ""} · concurrence ${CONCURRENCY} · fenêtre ${MAX_SECONDS}s` +
    ` · ${PX}px · ${OFF_POOL ? "HORS pool LLM" : "dans le pool batch"}`,
  );

  const budget = MAX_CALLS > 0 ? { left: MAX_CALLS } : undefined;
  const tally = { compliant: 0, fixable: 0, no_alternative: 0, deferred: 0, no_images: 0, error: 0 };
  let processed = 0;
  let calls = 0;
  let cacheHits = 0;
  let queued = 0;
  let stopped = "";

  // Simple worker pool over the todo list. Products are independent; the shared budget is
  // decremented in place so the cap holds across workers.
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (stopped) return;
      if (elapsed() > MAX_SECONDS) { stopped = `fenêtre de ${MAX_SECONDS}s atteinte`; return; }
      if (budget && budget.left <= 0) { stopped = `budget de ${MAX_CALLS} appels épuisé`; return; }
      const i = cursor++;
      if (i >= todo.length) return;
      const p = todo[i];

      const plan = await audit.auditProductPos1(p, {
        budget,
        includeFeedOnly: !NO_FEED,
        classifyOptions: { px: PX, maintenance: OFF_POOL },
      });

      // A product deferred purely because the budget ran out is NOT checkpointed: leaving it
      // out means the next window re-audits it instead of freezing a partial verdict.
      if (plan.status === "deferred" && plan.calls === 0) return;

      appendCheckpoint(plan);
      tally[plan.status]++;
      processed++;
      calls += plan.calls;
      cacheHits += plan.cacheHits;

      if (QUEUE && plan.status === "fixable" && plan.proposedUrl) {
        try {
          await db.upsertImageReview({
            shopifyProductId: plan.shopifyProductId,
            sku: plan.sku,
            name: plan.name,
            currentUrl: plan.currentUrl,
            currentReason: plan.currentReason,
            proposedImageId: plan.proposedImageId ?? null,
            proposedUrl: plan.proposedUrl,
            proposedPosition: plan.proposedPosition ?? null,
            proposedReason: plan.proposedReason ?? "",
            source: plan.proposedSource ?? "shopify",
          });
          queued++;
        } catch (err) {
          console.warn(`  ⚠ file d'approbation ${plan.sku}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (processed % 10 === 0) {
        console.log(
          `  ${processed}/${todo.length} · conformes ${tally.compliant} · corrigeables ${tally.fixable} · ` +
          `sans alt. ${tally.no_alternative} · erreurs ${tally.error} · appels ${calls} (cache ${cacheHits}) · ${Math.round(elapsed())}s`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const all = readCheckpoint();
  const { html, csv } = writeReport([...all.values()]);

  console.log("");
  console.log(`── fenêtre terminée${stopped ? ` (${stopped})` : ""} ──`);
  console.log(`produits audités cette fenêtre : ${processed}`);
  console.log(`appels Vision dépensés         : ${calls} (servis par le cache : ${cacheHits})`);
  if (QUEUE) console.log(`mis en file d'approbation      : ${queued}`);
  console.log(`cumul checkpoint               : ${all.size}/${products.length}`);
  console.log(`  conformes        : ${[...all.values()].filter((p) => p.status === "compliant").length}`);
  console.log(`  CORRIGEABLES     : ${[...all.values()].filter((p) => p.status === "fixable").length}`);
  console.log(`  sans alternative : ${[...all.values()].filter((p) => p.status === "no_alternative").length}`);
  console.log(`  erreurs/vides    : ${[...all.values()].filter((p) => p.status === "error" || p.status === "no_images").length}`);
  console.log(`rapport : ${html}`);
  console.log(`csv     : ${csv}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
