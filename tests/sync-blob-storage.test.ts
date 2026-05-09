/**
 * Unit tests for src/lib/sync-blob-storage.ts
 *
 * Covers:
 *   savePhase1Blob  — uploads JSON to Vercel Blob, returns URL
 *   readPhase1Blob  — URL validation, fetch, JSON parsing, shape check
 *   deletePhase1Blob — calls del(), swallows errors (cleanup is non-fatal)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@vercel/blob", () => ({
  put: vi.fn(),
  del: vi.fn().mockResolvedValue(undefined),
}));

import { put, del } from "@vercel/blob";
import { savePhase1Blob, readPhase1Blob, deletePhase1Blob } from "@/lib/sync-blob-storage";
import type { Phase1BlobData } from "@/lib/sync-blob-storage";

const VALID_BLOB_URL = "https://abc123.public.blob.vercel-storage.com/sync-runs/phase1/2026-05-09/run-xyz.json";

const SAMPLE_DATA: Phase1BlobData = {
  toWriteMapped: [
    {
      sku: "SKU-001", name: "Test Product", price: 99.99, qty: 10, color: "BK", size: "",
      product_type: "Home", image1: "https://img.example.com/1.jpg", image2: "", image3: "",
      image4: "", image5: "", image6: "", image7: "", video: "", description: "<p>desc</p>",
      short_description: "Short", material: "Wood", gtin: "123456789012", weight: 1.5,
      out_of_stock_expected: "", estimated_arrival: "", last_seen_at: 1715260800000,
    },
  ],
  priceChangeEntries: [
    { sku: "SKU-001", oldPrice: 110, newPrice: 99.99, oldQty: 10, newQty: 10, changeType: "price_drop" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── savePhase1Blob ────────────────────────────────────────────────────────────

describe("savePhase1Blob", () => {
  it("calls put() with correct path, content-type, and overwrite flag", async () => {
    vi.mocked(put).mockResolvedValueOnce({ url: VALID_BLOB_URL } as Awaited<ReturnType<typeof put>>);

    const url = await savePhase1Blob("run-xyz", SAMPLE_DATA);

    expect(url).toBe(VALID_BLOB_URL);
    expect(put).toHaveBeenCalledOnce();

    const [path, _body, opts] = vi.mocked(put).mock.calls[0]!;
    expect(path).toMatch(/sync-runs\/phase1\/\d{4}-\d{2}-\d{2}\/run-xyz\.json/);
    expect(opts).toMatchObject({
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  });

  it("serializes toWriteMapped + priceChangeEntries as JSON in the blob body", async () => {
    vi.mocked(put).mockResolvedValueOnce({ url: VALID_BLOB_URL } as Awaited<ReturnType<typeof put>>);

    await savePhase1Blob("run-xyz", SAMPLE_DATA);

    const [_path, body] = vi.mocked(put).mock.calls[0]!;
    const parsed = JSON.parse(body as string) as Phase1BlobData;
    expect(parsed.toWriteMapped).toHaveLength(1);
    expect(parsed.toWriteMapped[0]!.sku).toBe("SKU-001");
    expect(parsed.priceChangeEntries).toHaveLength(1);
    expect(parsed.priceChangeEntries[0]!.changeType).toBe("price_drop");
  });

  it("propagates put() errors (storage failure is fatal during init)", async () => {
    vi.mocked(put).mockRejectedValueOnce(new Error("Blob service unavailable"));

    await expect(savePhase1Blob("run-xyz", SAMPLE_DATA)).rejects.toThrow("Blob service unavailable");
  });
});

// ─── readPhase1Blob ────────────────────────────────────────────────────────────

describe("readPhase1Blob — URL validation", () => {
  it("throws when URL does not start with https://", async () => {
    await expect(readPhase1Blob("http://blob.vercel-storage.com/run.json"))
      .rejects.toThrow(/URL validation failed/);
  });

  it("throws when URL does not contain .vercel-storage.com/", async () => {
    await expect(readPhase1Blob("https://evil.com/run.json"))
      .rejects.toThrow(/URL validation failed/);
  });

  it("accepts a valid vercel-storage URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ toWriteMapped: [], priceChangeEntries: [] }),
    }));

    const data = await readPhase1Blob(VALID_BLOB_URL);
    expect(data.toWriteMapped).toEqual([]);
    expect(data.priceChangeEntries).toEqual([]);
  });
});

describe("readPhase1Blob — fetch errors", () => {
  it("throws when blob returns non-200 status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 404 }));

    await expect(readPhase1Blob(VALID_BLOB_URL))
      .rejects.toThrow(/Phase1 blob read failed: 404/);
  });

  it("throws when blob JSON is missing toWriteMapped array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ priceChangeEntries: [] }), // missing toWriteMapped
    }));

    await expect(readPhase1Blob(VALID_BLOB_URL))
      .rejects.toThrow(/malformed.*toWriteMapped/i);
  });

  it("throws when blob JSON is missing priceChangeEntries array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ toWriteMapped: [] }), // missing priceChangeEntries
    }));

    await expect(readPhase1Blob(VALID_BLOB_URL))
      .rejects.toThrow(/malformed.*priceChangeEntries/i);
  });

  it("throws when blob JSON is null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => null,
    }));

    await expect(readPhase1Blob(VALID_BLOB_URL))
      .rejects.toThrow(/malformed/i);
  });

  it("propagates AbortError from timeout signal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(Object.assign(new Error("Aborted"), { name: "AbortError" })));

    await expect(readPhase1Blob(VALID_BLOB_URL))
      .rejects.toThrow("Aborted");
  });

  it("returns full data when valid blob is fetched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_DATA,
    }));

    const data = await readPhase1Blob(VALID_BLOB_URL);
    expect(data.toWriteMapped).toHaveLength(1);
    expect(data.toWriteMapped[0]!.price).toBe(99.99);
    expect(data.priceChangeEntries[0]!.changeType).toBe("price_drop");
  });
});

// ─── deletePhase1Blob ──────────────────────────────────────────────────────────

describe("deletePhase1Blob", () => {
  it("calls del() with the provided URL", async () => {
    await deletePhase1Blob(VALID_BLOB_URL);
    expect(del).toHaveBeenCalledWith(VALID_BLOB_URL);
  });

  it("swallows del() errors — cleanup failure is non-fatal", async () => {
    vi.mocked(del).mockRejectedValueOnce(new Error("blob already deleted"));

    // Must not throw
    await expect(deletePhase1Blob(VALID_BLOB_URL)).resolves.toBeUndefined();
  });

  it("returns undefined on success", async () => {
    const result = await deletePhase1Blob(VALID_BLOB_URL);
    expect(result).toBeUndefined();
  });
});
