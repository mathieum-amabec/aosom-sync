import crypto from "crypto";
import { NextResponse } from "next/server";
import { fetchAosomCatalogRaw } from "@/lib/csv-fetcher";
import { upsertCachedCSV, appendCacheLog } from "@/lib/database";
import { isAuthenticated } from "@/lib/auth";
import { env, AOSOM } from "@/lib/config";

// Vercel Pro: 600s max. Reserve 60s for DB operations after a 540s fetch.
export const maxDuration = 600;

const FETCH_TIMEOUT_MS = 540_000;

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  let expected: string;
  try {
    expected = `Bearer ${env.cronSecret}`;
  } catch {
    return false;
  }
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

async function runPrecache(): Promise<{
  bytes_size: number;
  fetch_duration_ms: number;
  total_duration_ms: number;
}> {
  const t0 = Date.now();
  console.log(`[precache-csv] Starting fetch from ${AOSOM.CSV_URL}`);

  let fetchResult: { raw_text: string; bytes_size: number; duration_ms: number };
  try {
    fetchResult = await fetchAosomCatalogRaw(FETCH_TIMEOUT_MS);
    console.log(`[precache-csv] Fetched ${fetchResult.bytes_size} bytes in ${fetchResult.duration_ms}ms`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const total_duration_ms = Date.now() - t0;
    console.error(`[precache-csv] Fetch failed: ${errorMessage}`);
    try {
      await appendCacheLog({
        success: false,
        error_message: errorMessage,
        source_url: AOSOM.CSV_URL,
        fetch_duration_ms: total_duration_ms,
      });
    } catch (logErr) {
      console.error(`[precache-csv] appendCacheLog also failed:`, logErr);
    }
    throw err;
  }

  await upsertCachedCSV({
    raw_text: fetchResult.raw_text,
    bytes_size: fetchResult.bytes_size,
    fetch_duration_ms: fetchResult.duration_ms,
    source_url: AOSOM.CSV_URL,
    success: true,
  });

  await appendCacheLog({
    bytes_size: fetchResult.bytes_size,
    fetch_duration_ms: fetchResult.duration_ms,
    success: true,
    source_url: AOSOM.CSV_URL,
  });

  const total_duration_ms = Date.now() - t0;
  console.log(`[precache-csv] Done. total=${total_duration_ms}ms`);
  return { bytes_size: fetchResult.bytes_size, fetch_duration_ms: fetchResult.duration_ms, total_duration_ms };
}

/** Vercel cron trigger — Bearer CRON_SECRET required. */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = await runPrecache();
    return NextResponse.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: "PRECACHE_FAILED", message }, { status: 500 });
  }
}

/** Manual trigger — valid session cookie required. */
export async function POST(_request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = await runPrecache();
    return NextResponse.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: "PRECACHE_FAILED", message }, { status: 500 });
  }
}
