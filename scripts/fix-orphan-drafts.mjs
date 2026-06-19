// One-off backfill: enqueue the approved-but-orphaned facebook_drafts into
// publication_queue so /api/cron/publisher can finally publish them.
//
// Background: these drafts were approved BEFORE the queue cutover. The new
// `approve` action enqueues into publication_queue; these predate it, so they
// sit in facebook_drafts.status='approved' with no queue row and are never
// drained by either cron — effectively stuck. This script replays the exact
// `approve` enqueue path (POST /api/social {action:"approve"}) for them.
//
// It is a faithful mirror of src/app/api/social/route.ts → case "approve":
// it reuses the real libs (draftToQueueItems, getNextAvailableSlot, addToQueue)
// rather than reimplementing scheduling/payload logic, so it can't drift from
// production behavior. content_id = String(draft.id), so it is idempotent and
// the dashboard/publisher join keeps working.
//
// Usage (Windows ARM64 → run under x64 node; bun-x64 crashes on network scripts):
//   node --import tsx scripts/fix-orphan-drafts.mjs           # dry-run (default): no DB write
//   node --import tsx scripts/fix-orphan-drafts.mjs --apply   # actually enqueue
//
// Reads prod Turso creds from .env.local (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN).
// Idempotent: skips any (content_id, platform) pair already in publication_queue.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// The exact orphan IDs identified by the read-only audit (approved, absent from
// publication_queue). Hardcoded on purpose: this is a one-off, not a sweep.
const ORPHAN_IDS = [345, 332, 324, 287, 282, 281];

const APPLY = process.argv.includes("--apply");

// ── env: load .env.local manually (never printed); process.env wins ──────────
function loadEnv() {
  const text = readFileSync(join(ROOT, ".env.local"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

/** SQLite datetime() text ('YYYY-MM-DD HH:MM:SS' UTC) → unix seconds. Mirrors the route helper. */
function sqliteToUnixSec(s) {
  return Math.floor(Date.parse(`${s.replace(" ", "T")}Z`) / 1000);
}

async function main() {
  loadEnv();
  if (!process.env.TURSO_DATABASE_URL) {
    console.error("✗ TURSO_DATABASE_URL not found (process.env or .env.local). This script targets prod Turso.");
    process.exit(1);
  }

  // Import the real libs only after env is loaded (the DB client reads
  // TURSO_* lazily). Path alias @/ is resolved by tsx via tsconfig.json.
  const { getFacebookDraft, getSetting, getOccupiedQueueSlots, addToQueue, QueueSlotTakenError, ensureSchema } =
    await import("@/lib/database");
  const { getNextAvailableSlot } = await import("@/lib/publication-scheduler");
  const { draftToQueueItems } = await import("@/lib/social-publisher");
  const { activeChannels } = await import("@/lib/config");

  const db = await ensureSchema();
  const settings = { publication_schedule: (await getSetting("publication_schedule")) ?? "" };
  const nowSec = Math.floor(Date.now() / 1000);
  const channels = activeChannels();

  // Per-platform occupancy (unix sec). Seeded from the live queue, then grown
  // in-memory as we assign slots so each new item lands on a DISTINCT free slot
  // — even in dry-run where nothing is inserted. Mirrors approve's per-platform
  // occupancy + retry, but accumulates locally across all 6 drafts.
  const occupiedByPlatform = new Map();
  async function occupiedFor(platform) {
    if (!occupiedByPlatform.has(platform)) {
      const occ = (await getOccupiedQueueSlots(platform)).map(sqliteToUnixSec);
      occupiedByPlatform.set(platform, occ);
    }
    return occupiedByPlatform.get(platform);
  }

  // content_id → set of platforms already queued (any status) — idempotency.
  async function queuedPlatforms(contentId) {
    const rs = await db.execute({
      sql: `SELECT platform FROM publication_queue WHERE content_type = 'social' AND content_id = ?`,
      args: [String(contentId)],
    });
    return new Set(rs.rows.map((r) => String(r.platform)));
  }

  const assignments = []; // { id, sku, platform, atSec, iso, sqlite }
  const skipped = [];     // { id, reason }

  for (const id of ORPHAN_IDS) {
    const draft = await getFacebookDraft(id);
    if (!draft) {
      skipped.push({ id, reason: "draft introuvable" });
      continue;
    }
    if (draft.status !== "approved") {
      skipped.push({ id, reason: `status='${draft.status}' (attendu 'approved')` });
      continue;
    }

    const items = draftToQueueItems(draft, channels);
    if (items.length === 0) {
      skipped.push({ id, reason: "aucun item publishable (pas de caption/brand actif)" });
      continue;
    }

    const already = await queuedPlatforms(id);

    for (const item of items) {
      if (already.has(item.platform)) {
        skipped.push({ id, reason: `déjà en queue (platform='${item.platform}')` });
        continue;
      }

      const occupied = await occupiedFor(item.platform);
      let booked = false;
      // Retry past slots lost to a concurrent writer (apply mode), mirroring approve.
      for (let attempt = 0; attempt < 5; attempt++) {
        const next = await getNextAvailableSlot("facebook", settings, { nowSec, occupied });
        if (!next) {
          skipped.push({ id, reason: `aucun slot libre (platform='${item.platform}', schedule désactivé ?)` });
          break;
        }
        if (APPLY) {
          try {
            await addToQueue({
              contentType: "social",
              contentId: String(id),
              platform: item.platform,
              payload: JSON.stringify(item.payload),
              scheduledAt: next.sqlite,
            });
          } catch (err) {
            if (err instanceof QueueSlotTakenError) {
              occupied.push(next.at); // lost the race — recompute past this slot
              continue;
            }
            throw err;
          }
        }
        occupied.push(next.at); // book it (also reserves the slot in dry-run)
        assignments.push({
          id,
          sku: draft.sku ?? "-",
          platform: item.platform,
          atSec: next.at,
          iso: next.iso,
          sqlite: next.sqlite,
        });
        booked = true;
        break;
      }
      if (!booked && APPLY) {
        skipped.push({ id, reason: `slot non réservé après plusieurs tentatives (platform='${item.platform}')` });
      }
    }
  }

  // ── report ──────────────────────────────────────────────────────────────
  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} — backfill orphan approved drafts → publication_queue`);
  console.log(`Orphan IDs: ${ORPHAN_IDS.join(", ")}\n`);

  if (assignments.length) {
    console.log(`${APPLY ? "Enqueued" : "Would enqueue"} ${assignments.length} item(s):`);
    console.table(
      assignments.map((a) => ({
        draft_id: a.id,
        sku: a.sku,
        platform: a.platform,
        slot_utc: a.sqlite,
        slot_iso: a.iso,
      })),
    );
  } else {
    console.log("No items to enqueue.");
  }

  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  draft ${s.id}: ${s.reason}`);
  }

  console.log(
    `\nSummary: ${assignments.length} ${APPLY ? "enqueued" : "to enqueue"}, ${skipped.length} skipped.` +
      (APPLY ? "" : "\nRe-run with --apply to write to publication_queue."),
  );
}

main().catch((err) => {
  console.error("✗ fix-orphan-drafts failed:", err);
  process.exit(1);
});
