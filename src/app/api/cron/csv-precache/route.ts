import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import { AOSOM } from "@/lib/config";
import { upsertBlobCache, getCachedBlobUrl } from "@/lib/database";
import { trackCron } from "@/lib/cron-tracking";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const BLOB_KEY = "csv/aosom-feed/current.csv";
const MIN_CSV_BYTES = 10 * 1024 * 1024; // 10 MB sanity floor
/**
 * Absolute row floor. Lowered from 8,000 on 2026-09-12.
 *
 * 8,000 was set when the catalogue was ~10k rows and read as "obviously not an error
 * page". Aosom drifted down to ~7,960 and every precache run from 2026-09-10 18:00
 * onward died on `CSV has only 7962 data rows (min 8000)` — a 0.5% shortfall against a
 * hardcoded number, rejecting a perfectly good feed. The blob froze, Phase 1 kept
 * re-reading it, and two days later Phase 2 unpublished 30 live products.
 *
 * The lesson: a fixed floor set near the live value becomes a landmine the moment the
 * live value drifts. This floor is now far below any plausible catalogue and only exists
 * to catch a truncated download or an error page; real shrinkage is caught by the
 * relative check below, which moves with the catalogue instead of against it.
 */
const MIN_CSV_ROWS_ABSOLUTE = 4_000;
/** A feed under this fraction of the last good one is a truncation, not a catalogue change. */
const MIN_CSV_SIZE_RATIO = 0.7;

function validateCsvContent(csvText: string, previousSizeBytes?: number): void {
  // Reject HTML error pages that pass the size floor (e.g. a 12 MB Nginx error page)
  if (csvText.trimStart().startsWith("<")) {
    throw new Error(`CSV response looks like HTML, not a TSV feed (first chars: ${csvText.slice(0, 60)})`);
  }
  const rowCount = csvText.split("\n").filter((l) => l.trim().length > 0).length - 1; // minus header
  if (rowCount < MIN_CSV_ROWS_ABSOLUTE) {
    throw new Error(`CSV has only ${rowCount} data rows (min ${MIN_CSV_ROWS_ABSOLUTE})`);
  }
  // Relative floor: self-adjusting, so it keeps catching truncated downloads without
  // going off every time Aosom's catalogue drifts a few hundred products.
  if (previousSizeBytes && previousSizeBytes > 0) {
    const floor = Math.floor(previousSizeBytes * MIN_CSV_SIZE_RATIO);
    if (csvText.length < floor) {
      throw new Error(
        `CSV is ${csvText.length} bytes, under ${Math.round(MIN_CSV_SIZE_RATIO * 100)}% of the ` +
          `last cached ${previousSizeBytes} (floor ${floor}) — looks truncated`,
      );
    }
  }
}

function log(msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), job: "csv-precache", msg, ...extra }));
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const t_start = Date.now();

  try {
    // trackCron records this run (success/error) in cron_runs for the dashboard.
    // The work throws on any failure (bad CDN response, undersized/HTML feed, blob
    // upload error), so trackCron logs 'error' + message; the outer catch keeps the
    // route's existing 500 response shape.
    const data = await trackCron("csv-precache", async () => {
    log("precache_start");

    // Step 1: Download CSV from Aosom CDN
    const t_download = Date.now();
    const aosomResp = await fetch(AOSOM.CSV_URL, {
      signal: AbortSignal.timeout(240_000), // 4 min hard cap (under Vercel Pro 300s limit)
    });

    if (!aosomResp.ok) {
      throw new Error(`Aosom CDN returned ${aosomResp.status}`);
    }

    const csvText = await aosomResp.text();
    const download_duration_ms = Date.now() - t_download;
    const csv_size_bytes = csvText.length;

    log("aosom_download_complete", {
      phase: "aosom_download",
      duration_ms: download_duration_ms,
      size_mb: (csv_size_bytes / 1024 / 1024).toFixed(2),
    });

    if (csv_size_bytes < MIN_CSV_BYTES) {
      throw new Error(`CSV suspiciously small: ${csv_size_bytes} bytes (min ${MIN_CSV_BYTES})`);
    }
    // The previously cached size is the baseline for the relative floor. Read before the
    // upload so it is still the OLD entry (step 3 below re-reads it for blob cleanup).
    const priorCache = await getCachedBlobUrl();
    validateCsvContent(csvText, priorCache?.csv_size_bytes);

    // Step 2: Upload to Vercel Blob (fixed key, overwrite in-place)
    const t_upload = Date.now();
    const blob = await put(BLOB_KEY, csvText, {
      access: "public",
      contentType: "text/csv",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    const upload_duration_ms = Date.now() - t_upload;

    log("blob_upload_complete", {
      phase: "blob_upload",
      duration_ms: upload_duration_ms,
      url: blob.url,
    });

    // Step 3: Cleanup old blob if URL changed (defensive — fixed key should keep same URL)
    const previous = await getCachedBlobUrl();
    if (previous && previous.blob_url !== blob.url) {
      try {
        await del(previous.blob_url);
        log("old_blob_deleted", { old_url: previous.blob_url });
      } catch (cleanupErr) {
        log("old_blob_cleanup_failed", { err: String(cleanupErr) });
      }
    }

    // Step 4: Persist to DB
    await upsertBlobCache({ blob_url: blob.url, blob_key: BLOB_KEY, csv_size_bytes, upload_duration_ms, download_duration_ms });

    const total_duration_ms = Date.now() - t_start;
    log("precache_complete", { phase: "precache_complete", duration_ms: total_duration_ms });

      return {
        size_mb: (csv_size_bytes / 1024 / 1024).toFixed(2),
        download_duration_ms,
        upload_duration_ms,
        total_duration_ms,
      };
    });

    return NextResponse.json({ success: true, data });
  } catch (err) {
    const total_duration_ms = Date.now() - t_start;
    const error_msg = err instanceof Error ? err.message : String(err);
    log("precache_failed", { err: error_msg, duration_ms: total_duration_ms });
    return NextResponse.json({ success: false, error: error_msg, duration_ms: total_duration_ms }, { status: 500 });
  }
}
