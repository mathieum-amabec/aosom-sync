/**
 * Inventory write path of shopify-client — getPrimaryLocationId, enableVariantTracking,
 * setInventoryLevel and the active-variant reader that feeds the daily sweep.
 *
 * These four had no test at all despite being called from job1-sync, diff-engine and
 * inventory-sweep, i.e. from the daily cron that writes stock levels to the live store.
 *
 * Every test re-imports the module (vi.resetModules) because getPrimaryLocationId caches
 * the location id in a module-level variable for the life of the process — sharing one
 * import across tests would let the first call's result leak into the rest.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Token presence is a per-test switch rather than a doMock/doUnmock dance: unmocking
// mid-file makes every later vi.resetModules() reload the REAL config, which throws.
let hasToken = true;
vi.mock("@/lib/config", () => ({
  env: {
    get shopifyAccessToken() { return hasToken ? "test-token" : ""; },
    get hasShopifyToken() { return hasToken; },
  },
  SHOPIFY: { STORE: "test.myshopify.com", API_VERSION: "2025-01" },
  SYNC: { MIN_DISCOUNT_DISPLAY_PERCENT: 10 },
}));

/** Minimal Response stand-in: only what shopify-client actually reads. */
function res(
  body: unknown,
  init: { status?: number; link?: string | null; text?: string } = {},
) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h === "Link" ? (init.link ?? null) : null) },
    json: async () => body,
    text: async () => init.text ?? JSON.stringify(body),
  };
}

async function load() {
  vi.resetModules();
  return import("@/lib/shopify-client");
}

/** The endpoint of the nth fetch call, without the store/version prefix. */
function endpoint(n: number): string {
  return String(mockFetch.mock.calls[n][0]).replace(
    "https://test.myshopify.com/admin/api/2025-01",
    "",
  );
}
function bodyOf(n: number): Record<string, unknown> {
  return JSON.parse(String(mockFetch.mock.calls[n][1].body));
}

beforeEach(() => {
  mockFetch.mockReset();
  hasToken = true;
});

describe("getPrimaryLocationId", () => {
  it("prefers the active location over the first one listed", async () => {
    const { getPrimaryLocationId } = await load();
    mockFetch.mockResolvedValue(
      res({ locations: [{ id: 1, active: false }, { id: 2, active: true }] }),
    );

    expect(await getPrimaryLocationId()).toBe("2");
    expect(endpoint(0)).toBe("/locations.json");
  });

  it("falls back to the first location when none is marked active", async () => {
    const { getPrimaryLocationId } = await load();
    mockFetch.mockResolvedValue(
      res({ locations: [{ id: 7, active: false }, { id: 8, active: false }] }),
    );

    expect(await getPrimaryLocationId()).toBe("7");
  });

  it("caches for the life of the module — a second call issues no request", async () => {
    const { getPrimaryLocationId } = await load();
    mockFetch.mockResolvedValue(res({ locations: [{ id: 42, active: true }] }));

    expect(await getPrimaryLocationId()).toBe("42");
    expect(await getPrimaryLocationId()).toBe("42");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("throws when the store returns an empty location list", async () => {
    const { getPrimaryLocationId } = await load();
    mockFetch.mockResolvedValue(res({ locations: [] }));

    await expect(getPrimaryLocationId()).rejects.toThrow(/no locations/i);
  });

  it("surfaces the HTTP status and body when the call fails", async () => {
    const { getPrimaryLocationId } = await load();
    mockFetch.mockResolvedValue(res({}, { status: 403, text: "read_locations scope missing" }));

    await expect(getPrimaryLocationId()).rejects.toThrow(/403 — read_locations scope missing/);
  });
});

describe("enableVariantTracking", () => {
  it("PUTs tracked:true against the inventory item, with a numeric id", async () => {
    const { enableVariantTracking } = await load();
    mockFetch.mockResolvedValue(res({ inventory_item: { id: 99, tracked: true } }));

    await enableVariantTracking("99");

    expect(endpoint(0)).toBe("/inventory_items/99.json");
    expect(mockFetch.mock.calls[0][1].method).toBe("PUT");
    // Shopify rejects a string id here — the client must coerce it.
    expect(bodyOf(0)).toEqual({ inventory_item: { id: 99, tracked: true } });
  });

  it("names the inventory item in the error so a failing sweep is diagnosable", async () => {
    const { enableVariantTracking } = await load();
    mockFetch.mockResolvedValue(res({}, { status: 422, text: "cannot track" }));

    await expect(enableVariantTracking("99")).rejects.toThrow(/\(99\).*422 — cannot track/);
  });
});

describe("setInventoryLevel", () => {
  it("POSTs the absolute quantity with numeric ids", async () => {
    const { setInventoryLevel } = await load();
    mockFetch.mockResolvedValue(res({ inventory_level: { available: 6 } }));

    await setInventoryLevel("11", "22", 6);

    expect(endpoint(0)).toBe("/inventory_levels/set.json");
    expect(bodyOf(0)).toEqual({ location_id: 22, inventory_item_id: 11, available: 6 });
  });

  it("connects the item to the location, then retries, when Shopify says it is not stocked", async () => {
    const { setInventoryLevel } = await load();
    mockFetch
      .mockResolvedValueOnce(res({}, { status: 422, text: "inventory item is not stocked at this location" }))
      .mockResolvedValueOnce(res({ inventory_level: {} })) // connect
      .mockResolvedValueOnce(res({ inventory_level: { available: 6 } })); // retried set

    await setInventoryLevel("11", "22", 6);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(endpoint(0)).toBe("/inventory_levels/set.json");
    expect(endpoint(1)).toBe("/inventory_levels/connect.json");
    expect(bodyOf(1)).toEqual({ location_id: 22, inventory_item_id: 11 });
    // The retry must re-send the original quantity, not a connect-shaped body.
    expect(endpoint(2)).toBe("/inventory_levels/set.json");
    expect(bodyOf(2)).toEqual({ location_id: 22, inventory_item_id: 11, available: 6 });
  });

  it("does NOT attempt a connect for a 422 that is not about stocking", async () => {
    const { setInventoryLevel } = await load();
    mockFetch.mockResolvedValue(res({}, { status: 422, text: "inventory item is not tracked" }));

    await expect(setInventoryLevel("11", "22", 6)).rejects.toThrow(/422 — inventory item is not tracked/);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("throws when the connect itself fails, rather than retrying blindly", async () => {
    const { setInventoryLevel } = await load();
    mockFetch
      .mockResolvedValueOnce(res({}, { status: 422, text: "not stocked" }))
      .mockResolvedValueOnce(res({}, { status: 403, text: "write_inventory missing" }));

    await expect(setInventoryLevel("11", "22", 6)).rejects.toThrow(/connect failed \(11\): 403/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws when the retried set still fails", async () => {
    const { setInventoryLevel } = await load();
    mockFetch
      .mockResolvedValueOnce(res({}, { status: 422, text: "not stocked" }))
      .mockResolvedValueOnce(res({}))
      .mockResolvedValueOnce(res({}, { status: 500, text: "boom" }));

    await expect(setInventoryLevel("11", "22", 6)).rejects.toThrow(/set inventory failed \(11\): 500/);
  });

  it("writes zero as a real quantity, not as a falsy no-op", async () => {
    const { setInventoryLevel } = await load();
    mockFetch.mockResolvedValue(res({}));

    await setInventoryLevel("11", "22", 0);

    expect(bodyOf(0)).toMatchObject({ available: 0 });
  });
});

describe("fetchActiveVariantInventory", () => {
  it("filters on status=active and flattens every variant", async () => {
    const { fetchActiveVariantInventory } = await load();
    mockFetch.mockResolvedValue(
      res({
        products: [
          {
            id: 1,
            variants: [
              { sku: "A-1", inventory_quantity: 5, inventory_item_id: 100, inventory_management: "shopify" },
              { sku: "A-2", inventory_quantity: 0, inventory_item_id: 101, inventory_management: null },
            ],
          },
        ],
      }),
    );

    const out = await fetchActiveVariantInventory();

    expect(endpoint(0)).toContain("status=active");
    expect(out).toEqual([
      { sku: "A-1", inventoryQuantity: 5, inventoryItemId: "100", tracked: true },
      { sku: "A-2", inventoryQuantity: 0, inventoryItemId: "101", tracked: false },
    ]);
  });

  it("drops variants with no SKU — the sweep keys on SKU and cannot use them", async () => {
    const { fetchActiveVariantInventory } = await load();
    mockFetch.mockResolvedValue(
      res({ products: [{ id: 1, variants: [{ sku: "", inventory_item_id: 1 }, { sku: "OK", inventory_item_id: 2 }] }] }),
    );

    const out = await fetchActiveVariantInventory();

    expect(out.map((v) => v.sku)).toEqual(["OK"]);
  });

  it("drops the status filter on paginated follow-ups (Shopify rejects it with page_info)", async () => {
    const { fetchActiveVariantInventory } = await load();
    mockFetch
      .mockResolvedValueOnce(
        res({ products: [{ id: 1, variants: [{ sku: "P1", inventory_item_id: 1 }] }] }, {
          link: '<https://test.myshopify.com/admin/api/2025-01/products.json?page_info=NEXT123&limit=250>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(res({ products: [{ id: 2, variants: [{ sku: "P2", inventory_item_id: 2 }] }] }));

    const out = await fetchActiveVariantInventory();

    expect(out.map((v) => v.sku)).toEqual(["P1", "P2"]);
    expect(endpoint(0)).toContain("status=active");
    expect(endpoint(1)).toContain("page_info=NEXT123");
    expect(endpoint(1)).not.toContain("status=");
  });

  it("returns [] instead of throwing when no Shopify token is configured", async () => {
    hasToken = false;
    const { fetchActiveVariantInventory } = await load();

    expect(await fetchActiveVariantInventory()).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
