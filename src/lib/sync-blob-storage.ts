import { put, del } from "@vercel/blob";
import type { ChangeTypeHistory } from "@/lib/database";

export interface Phase1BlobProductRow {
  sku: string; name: string; price: number; qty: number;
  color: string; size: string; product_type: string;
  image1: string; image2: string; image3: string; image4: string;
  image5: string; image6: string; image7: string;
  video: string; description: string; short_description: string;
  material: string; gtin: string; weight: number;
  out_of_stock_expected: string; estimated_arrival: string; last_seen_at: number;
}

export interface Phase1BlobPriceEntry {
  sku: string;
  oldPrice: number | null;
  newPrice: number | null;
  oldQty: number | null;
  newQty: number | null;
  changeType: ChangeTypeHistory;
}

export interface Phase1BlobData {
  toWriteMapped: Phase1BlobProductRow[];
  priceChangeEntries: Phase1BlobPriceEntry[];
}

const BLOB_PREFIX = "sync-runs/phase1";
// 60s: observed Vercel Blob degradation (11 mai 06:00-08:00 UTC) caused 19MB reads to exceed 30s.
const BLOB_FETCH_TIMEOUT_MS = 60_000;

export async function savePhase1Blob(runId: string, data: Phase1BlobData): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const path = `${BLOB_PREFIX}/${today}/${runId}.json`;
  const blob = await put(path, JSON.stringify(data), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return blob.url;
}

export async function readPhase1Blob(blobUrl: string): Promise<Phase1BlobData> {
  if (!blobUrl.startsWith("https://") || !blobUrl.includes(".vercel-storage.com/")) {
    throw new Error(`Phase1 blob URL validation failed: unexpected host in ${blobUrl}`);
  }
  const res = await fetch(blobUrl, { signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Phase1 blob read failed: ${res.status} ${blobUrl}`);
  const data = await res.json() as Phase1BlobData;
  if (!Array.isArray(data?.toWriteMapped) || !Array.isArray(data?.priceChangeEntries)) {
    throw new Error(`Phase1 blob data malformed: missing toWriteMapped or priceChangeEntries`);
  }
  return data;
}

export async function deletePhase1Blob(blobUrl: string): Promise<void> {
  try {
    await del(blobUrl);
  } catch {
    // cleanup failure is non-fatal
  }
}
