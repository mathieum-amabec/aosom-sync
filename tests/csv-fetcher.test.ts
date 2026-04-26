import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { parseTsv, fetchAosomCatalog, fetchAosomCatalogRaw } from "@/lib/csv-fetcher";

const FIXTURE = readFileSync(
  path.join(__dirname, "fixtures/sample.csv"),
  "utf-8"
);

describe("CSV Parser", () => {
  it("parses the CSV fixture into products", () => {
    const products = parseTsv(FIXTURE);
    expect(products.length).toBeGreaterThan(0);
  });

  it("extracts all required fields from first product", () => {
    const products = parseTsv(FIXTURE);
    const first = products[0];

    expect(first.sku).toBeTruthy();
    expect(first.name).toBeTruthy();
    expect(typeof first.price).toBe("number");
    expect(first.price).toBeGreaterThan(0);
    expect(typeof first.qty).toBe("number");
    expect(first.productType).toBeTruthy();
    expect(first.images.length).toBeGreaterThan(0);
  });

  it("replaces [BRAND NAME] in descriptions", () => {
    const products = parseTsv(FIXTURE);
    for (const p of products) {
      expect(p.description).not.toContain("[BRAND NAME]");
      expect(p.shortDescription).not.toContain("[BRAND NAME]");
    }
  });

  it("collects images from Image, Images, and Image1-7 fields", () => {
    const products = parseTsv(FIXTURE);
    const withImages = products.filter((p) => p.images.length > 1);
    expect(withImages.length).toBeGreaterThan(0);
    // No duplicate images
    for (const p of withImages) {
      const unique = new Set(p.images);
      expect(unique.size).toBe(p.images.length);
    }
  });

  it("extracts brand from product name", () => {
    const products = parseTsv(FIXTURE);
    for (const p of products) {
      expect(p.brand).toBeTruthy();
    }
  });

  it("handles empty/missing fields gracefully", () => {
    const csv = `"SKU","Image","Name","Price","custom_tagid","Category","Qty","color","size","short_description","Images","description","Gtin","Weight","Length","Width","Height","Psin","Product_Type","Sin","Estimated Arrival Time","Out Of Stock Expected","pdf","Material","Package_Num","Image1","Image2","Image3","Image4","Image5","Image6","Image7","Box_Size","Box_Weight","Video"
TEST-001,,"Test Product",99.99,,,5,,,,,,,,,,,,,,,,,,,,,,,,,`;
    const products = parseTsv(csv);
    expect(products).toHaveLength(1);
    expect(products[0].sku).toBe("TEST-001");
    expect(products[0].price).toBe(99.99);
    expect(products[0].qty).toBe(5);
    expect(products[0].images).toHaveLength(0);
  });

  it("skips rows with empty SKU", () => {
    const csv = `"SKU","Image","Name","Price","custom_tagid","Category","Qty","color","size","short_description","Images","description","Gtin","Weight","Length","Width","Height","Psin","Product_Type","Sin","Estimated Arrival Time","Out Of Stock Expected","pdf","Material","Package_Num","Image1","Image2","Image3","Image4","Image5","Image6","Image7","Box_Size","Box_Weight","Video"
,,"No SKU",10,,,,,,,,,,,,,,,,,,,,,,,,,,,,`;
    const products = parseTsv(csv);
    expect(products).toHaveLength(0);
  });
});

describe("fetchAosomCatalog", () => {
  const SAMPLE_CSV = readFileSync(
    path.join(__dirname, "fixtures/sample.csv"),
    "utf-8"
  );

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns parsed products when CSV downloads within timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_CSV })
    );

    const products = await fetchAosomCatalog();
    expect(products.length).toBeGreaterThan(0);
  });

  it("throws with explicit message when body stream exceeds 240s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, options: RequestInit) => {
        const signal = options?.signal as AbortSignal | undefined;
        return {
          ok: true,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              });
            }),
        };
      })
    );

    // Attach rejection handler BEFORE advancing time — avoids unhandled-rejection noise
    const assertion = expect(fetchAosomCatalog()).rejects.toThrow("240s");
    await vi.advanceTimersByTimeAsync(240_001);
    await assertion;
  });

  it("throws with explicit message when fetch itself hangs past 240s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, options: RequestInit) => {
        const signal = options?.signal as AbortSignal | undefined;
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      })
    );

    const assertion = expect(fetchAosomCatalog()).rejects.toThrow("240s");
    await vi.advanceTimersByTimeAsync(240_001);
    await assertion;
  });

  it("calls clearTimeout in finally even when fetch throws a network error", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    await expect(fetchAosomCatalog()).rejects.toThrow("fetch failed");
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry on HTTP 5xx — single fetch call, throws with status", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchAosomCatalog()).rejects.toThrow("HTTP 503");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("fetchAosomCatalogRaw", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns raw text, bytes_size, and duration_ms on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => "raw csv content" })
    );

    const result = await fetchAosomCatalogRaw();
    expect(result.raw_text).toBe("raw csv content");
    expect(result.bytes_size).toBeGreaterThan(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("throws with default 240s message when body stream hangs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, options: RequestInit) => {
        const signal = options?.signal as AbortSignal | undefined;
        return {
          ok: true,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              });
            }),
        };
      })
    );

    const assertion = expect(fetchAosomCatalogRaw()).rejects.toThrow("240s");
    await vi.advanceTimersByTimeAsync(240_001);
    await assertion;
  });

  it("respects custom timeoutMs parameter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, options: RequestInit) => {
        const signal = options?.signal as AbortSignal | undefined;
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      })
    );

    const assertion = expect(fetchAosomCatalogRaw(10_000)).rejects.toThrow("10s");
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
  });

  it("throws on HTTP 5xx without retry — single fetch call", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchAosomCatalogRaw()).rejects.toThrow("HTTP 503");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
