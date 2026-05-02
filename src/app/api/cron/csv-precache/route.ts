import crypto from "crypto";
import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import { env, AOSOM } from "@/lib/config";
import { upsertBlobCache, getCachedBlobUrl } from "@/lib/database";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const BLOB_KEY = "csv/aosom-feed/current.csv";
const MIN_CSV_BYTES = 10 * 1024 * 1024; // 10 MB sanity floor
const MIN_CSV_ROWS = 8_000; // Aosom catalog has ~10k products; HTML error pages have none

function validateCsvContent(csvText: string): void {
  // Reject HTML error pages that pass the size floor (e.g. a 12 MB Nginx error page)
  if (csvText.trimStart().startsWith("<")) {
    throw new Error(`CSV response looks like HTML, not a TSV feed (first chars: ${csvText.slice(0, 60)})`);
  }
  const rowCount = csvText.split("\n").filter((l) => l.trim().length > 0).length - 1; // minus header
  if (rowCount < MIN_CSV_ROWS) {
    throw new Error(`CSV has only ${rowCount} data rows (min ${MIN_CSV_ROWS})`);
  }
}

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
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
    validateCsvContent(csvText);

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

    return NextResponse.json({
      success: true,
      data: {
        size_mb: (csv_size_bytes / 1024 / 1024).toFixed(2),
        download_duration_ms,
        upload_duration_ms,
        total_duration_ms,
      },
    });
  } catch (err) {
    const total_duration_ms = Date.now() - t_start;
    const error_msg = err instanceof Error ? err.message : String(err);
    log("precache_failed", { err: error_msg, duration_ms: total_duration_ms });
    return NextResponse.json({ success: false, error: error_msg, duration_ms: total_duration_ms }, { status: 500 });
  }
}
