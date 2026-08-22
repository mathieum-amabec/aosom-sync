/**
 * GET /api/cron/stock-check — the intraday stock reconciliation (10:00 / 16:00 / 22:00 UTC).
 *
 * It ran with zero test coverage while being the thing that decides, three times a day and
 * unattended, which products are shown as out of stock, which get drafted as discontinued,
 * and which get republished. Its failure mode is silent: no crash, just a catalogue that
 * says the wrong thing.
 *
 * The tag helpers (applyStockTags / hasAutoDraftedTag / removeAutoDraftedTag) are deliberately
 * NOT mocked — the point of most of these tests is the exact tag list written to Shopify.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({ env: { cronSecret: "test-secret" } }));

// trackCron is transparent here; the run's own bookkeeping is covered by its own tests.
vi.mock("@/lib/cron-tracking", () => ({
  trackCron: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/csv-fetcher", () => ({ fetchAosomCatalog: vi.fn() }));
vi.mock("@/lib/database", () => ({
  getStockBaseline: vi.fn(),
  updateStockBaselineQty: vi.fn(),
}));
vi.mock("@/lib/shopify-client", () => ({
  getShopifyStockState: vi.fn(),
  updateShopifyProduct: vi.fn(),
  fetchDraftProductStates: vi.fn(),
}));
vi.mock("@/lib/stock-reconcile", () => ({
  planStockActions: vi.fn(),
  assertFeedComplete: vi.fn(),
}));
vi.mock("@/jobs/job1-sync", () => ({ notifyBackInStockWaitlist: vi.fn() }));

import { GET } from "@/app/api/cron/stock-check/route";
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import { getStockBaseline, updateStockBaselineQty } from "@/lib/database";
import { getShopifyStockState, updateShopifyProduct, fetchDraftProductStates } from "@/lib/shopify-client";
import { planStockActions, assertFeedComplete } from "@/lib/stock-reconcile";
import { notifyBackInStockWaitlist } from "@/jobs/job1-sync";
import { trackCron } from "@/lib/cron-tracking";

type Action = "oos" | "restock" | "draft" | "reactivate";

function req(query = "", auth: string | null = "Bearer test-secret"): Request {
  return new Request(`http://localhost/api/cron/stock-check${query}`, {
    headers: auth ? { authorization: auth } : {},
  });
}

function action(over: Partial<{ shopifyProductId: string; skus: string[]; action: Action; targetInStock: boolean; restockSkus: string[] }> = {}) {
  return {
    shopifyProductId: "1",
    skus: ["SKU-1"],
    action: "oos" as Action,
    targetInStock: false,
    restockSkus: [],
    ...over,
  };
}

function plan(actions: ReturnType<typeof action>[], qtyUpdates: Array<{ sku: string; qty: number }> = []) {
  return {
    actions,
    qtyUpdates,
    counts: { products: actions.length, wentOOS: 0, restocked: 0, drafted: 0, reactivated: 0 },
  };
}

/** Live Shopify state for the product being processed. */
function state(over: Partial<{ status: "active" | "draft" | "archived"; tags: string[] }> = {}) {
  return { status: "active" as const, tags: [] as string[], ...over };
}

async function body(res: Response) {
  return (await res.json()) as { success: boolean; data?: Record<string, number>; error?: string };
}

/** The product payload of the nth updateShopifyProduct call. */
function wrote(n: number) {
  return vi.mocked(updateShopifyProduct).mock.calls[n][1] as { tags?: string[]; status?: string };
}

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: clear only wipes recorded calls, so an implementation
  // installed by one test (assertFeedComplete throwing, say) would leak into every later one.
  // Everything the route needs is therefore re-installed below, trackCron included.
  vi.resetAllMocks();
  vi.mocked(trackCron).mockImplementation(async (_name: string, fn: () => Promise<unknown>) => fn() as never);
  vi.mocked(assertFeedComplete).mockImplementation(() => {});
  vi.mocked(fetchAosomCatalog).mockResolvedValue([{ sku: "SKU-1", qty: 10 }] as never);
  vi.mocked(getStockBaseline).mockResolvedValue([] as never);
  vi.mocked(fetchDraftProductStates).mockResolvedValue([]);
  vi.mocked(getShopifyStockState).mockResolvedValue(state());
  vi.mocked(updateShopifyProduct).mockResolvedValue(undefined as never);
  vi.mocked(updateStockBaselineQty).mockResolvedValue(undefined as never);
  vi.mocked(notifyBackInStockWaitlist).mockResolvedValue(undefined as never);
  vi.mocked(planStockActions).mockReturnValue(plan([]) as never);
});

describe("auth", () => {
  it("401s with no Authorization header, before doing any work", async () => {
    const res = await GET(req("", null));

    expect(res.status).toBe(401);
    expect(fetchAosomCatalog).not.toHaveBeenCalled();
  });

  it("401s on a wrong bearer token", async () => {
    const res = await GET(req("", "Bearer nope"));

    expect(res.status).toBe(401);
    expect(fetchAosomCatalog).not.toHaveBeenCalled();
  });
});

describe("feed-completeness guard", () => {
  it("aborts with a 500 before ANY Shopify write when the feed is implausibly thin", async () => {
    vi.mocked(assertFeedComplete).mockImplementation(() => {
      throw new Error("feed coverage 0.12 below 0.70");
    });

    const res = await GET(req());

    expect(res.status).toBe(500);
    expect((await body(res)).success).toBe(false);
    // The whole point of the guard: a truncated CSV must not mass-flip the catalogue.
    expect(planStockActions).not.toHaveBeenCalled();
    expect(updateShopifyProduct).not.toHaveBeenCalled();
  });
});

describe("dry run", () => {
  it("plans without writing, and returns the plan", async () => {
    vi.mocked(planStockActions).mockReturnValue(plan([action({ action: "oos" })]) as never);

    const res = await GET(req("?dryRun=1"));
    const b = await body(res);

    expect(res.status).toBe(200);
    expect(b.data!.dryRun).toBe(true);
    expect(b.data!.wentOOS).toBe(1);
    expect(updateShopifyProduct).not.toHaveBeenCalled();
    expect(updateStockBaselineQty).not.toHaveBeenCalled();
    expect(notifyBackInStockWaitlist).not.toHaveBeenCalled();
    expect((b.data as unknown as { planned: unknown[] }).planned).toHaveLength(1);
  });

  it("records under a separate cron name so dry runs do not pollute the real run history", async () => {
    await GET(req("?dryRun=1"));
    expect(vi.mocked(trackCron).mock.calls[0][0]).toBe("stock-check-dryrun");

    vi.clearAllMocks();
    vi.mocked(planStockActions).mockReturnValue(plan([]) as never);
    await GET(req());
    expect(vi.mocked(trackCron).mock.calls[0][0]).toBe("stock-check");
  });
});

describe("out of stock", () => {
  it("tags the product out-of-stock and leaves it active", async () => {
    vi.mocked(getShopifyStockState).mockResolvedValue(state({ tags: ["patio", "back-in-stock"] }));
    vi.mocked(planStockActions).mockReturnValue(plan([action({ action: "oos" })]) as never);

    const b = await body(await GET(req()));

    expect(b.data!.wentOOS).toBe(1);
    // Stays active: the badge and the back-in-stock waitlist both need a live product page.
    expect(wrote(0)).toEqual({ tags: ["patio", "out-of-stock"] });
    expect(wrote(0).status).toBeUndefined();
  });
});

describe("restock", () => {
  it("tags back-in-stock without reactivating a product we did not draft", async () => {
    vi.mocked(getShopifyStockState).mockResolvedValue(state({ status: "draft", tags: ["out-of-stock"] }));
    vi.mocked(planStockActions).mockReturnValue(
      plan([action({ action: "restock", targetInStock: true })]) as never,
    );

    await GET(req());

    // Draft, but WITHOUT our auto-drafted marker → an operator drafted it by hand. Never
    // resurrect that; only fix the tag.
    expect(wrote(0)).toEqual({ tags: ["back-in-stock"] });
  });

  it("reactivates and drops our marker when we are the ones who drafted it", async () => {
    vi.mocked(getShopifyStockState).mockResolvedValue(
      state({ status: "draft", tags: ["auto-drafted", "out-of-stock"] }),
    );
    vi.mocked(planStockActions).mockReturnValue(
      plan([action({ action: "restock", targetInStock: true })]) as never,
    );

    await GET(req());

    expect(wrote(0)).toEqual({ status: "active", tags: ["back-in-stock"] });
  });

  it("respects the operator's exclude-stale opt-out and does not reactivate", async () => {
    vi.mocked(getShopifyStockState).mockResolvedValue(
      state({ status: "draft", tags: ["auto-drafted", "exclude-stale"] }),
    );
    vi.mocked(planStockActions).mockReturnValue(
      plan([action({ action: "restock", targetInStock: true })]) as never,
    );

    await GET(req());

    expect(wrote(0).status).toBeUndefined();
    // The marker is only cleared when we actually bring the product back.
    expect(wrote(0).tags).toContain("auto-drafted");
  });

  it("notifies the waitlist BEFORE persisting the new baseline", async () => {
    const order: string[] = [];
    vi.mocked(notifyBackInStockWaitlist).mockImplementation(async () => { order.push("notify"); });
    vi.mocked(updateStockBaselineQty).mockImplementation(async () => { order.push("baseline"); });
    vi.mocked(planStockActions).mockReturnValue(
      plan([action({ action: "restock", targetInStock: true, restockSkus: ["SKU-1"] })], [{ sku: "SKU-1", qty: 10 }]) as never,
    );

    const b = await body(await GET(req()));

    // At-least-once: crashing between the two must re-detect and re-notify next run,
    // never drop the alert.
    expect(order).toEqual(["notify", "baseline"]);
    expect(notifyBackInStockWaitlist).toHaveBeenCalledWith(["SKU-1"]);
    expect(b.data!.notified).toBe(1);
  });
});

describe("draft (discontinued)", () => {
  it("drafts an active product and stamps our auto-drafted marker", async () => {
    vi.mocked(getShopifyStockState).mockResolvedValue(state({ tags: ["patio"] }));
    vi.mocked(planStockActions).mockReturnValue(plan([action({ action: "draft" })]) as never);

    const b = await body(await GET(req()));

    expect(b.data!.drafted).toBe(1);
    expect(wrote(0)).toEqual({ status: "draft", tags: ["patio", "out-of-stock", "auto-drafted"] });
  });

  it("skips a product that is already draft rather than re-writing it", async () => {
    vi.mocked(getShopifyStockState).mockResolvedValue(state({ status: "draft" }));
    vi.mocked(planStockActions).mockReturnValue(plan([action({ action: "draft" })]) as never);

    const b = await body(await GET(req()));

    expect(b.data!.skipped).toBe(1);
    expect(b.data!.drafted).toBe(0);
    expect(updateShopifyProduct).not.toHaveBeenCalled();
  });
});

describe("reactivate", () => {
  it("republishes a product we drafted that is back in the feed", async () => {
    vi.mocked(getShopifyStockState).mockResolvedValue(
      state({ status: "draft", tags: ["auto-drafted", "out-of-stock"] }),
    );
    vi.mocked(planStockActions).mockReturnValue(plan([action({ action: "reactivate" })]) as never);

    const b = await body(await GET(req()));

    expect(b.data!.reactivated).toBe(1);
    expect(wrote(0)).toEqual({ status: "active", tags: ["back-in-stock"] });
  });

  it.each([
    ["an operator already re-activated it", state({ status: "active", tags: ["auto-drafted"] })],
    ["the marker is gone — an operator drafted it by hand", state({ status: "draft", tags: [] })],
    ["the operator pinned it with exclude-stale", state({ status: "draft", tags: ["auto-drafted", "exclude-stale"] })],
  ])("re-checks live state and skips when %s", async (_label, live) => {
    vi.mocked(getShopifyStockState).mockResolvedValue(live);
    vi.mocked(planStockActions).mockReturnValue(plan([action({ action: "reactivate" })]) as never);

    const b = await body(await GET(req()));

    expect(b.data!.skipped).toBe(1);
    expect(b.data!.reactivated).toBe(0);
    expect(updateShopifyProduct).not.toHaveBeenCalled();
  });
});

describe("ordering and the write cap", () => {
  it("processes availability losses before restocks, so the cap cannot starve rupture detection", async () => {
    const seen: string[] = [];
    vi.mocked(getShopifyStockState).mockImplementation(async (id: string) => {
      seen.push(id);
      return state({ status: "active", tags: [] });
    });
    vi.mocked(planStockActions).mockReturnValue(
      plan([
        action({ shopifyProductId: "reactivate", action: "reactivate" }),
        action({ shopifyProductId: "restock", action: "restock", targetInStock: true }),
        action({ shopifyProductId: "draft", action: "draft" }),
        action({ shopifyProductId: "oos", action: "oos" }),
      ]) as never,
    );

    await GET(req());

    expect(seen).toEqual(["oos", "draft", "restock", "reactivate"]);
  });

  it("defers everything past the 150-write cap instead of writing it", async () => {
    vi.mocked(planStockActions).mockReturnValue(
      plan(Array.from({ length: 155 }, (_, i) => action({ shopifyProductId: String(i), action: "oos" }))) as never,
    );

    const b = await body(await GET(req()));

    expect(b.data!.wentOOS).toBe(150);
    expect(b.data!.deferred).toBe(5);
    expect(updateShopifyProduct).toHaveBeenCalledTimes(150);
  });

  it("does not spend cap budget on a product that vanished from Shopify", async () => {
    // 404s cost no write, so a catalogue full of deleted products must not eat the budget.
    vi.mocked(getShopifyStockState).mockResolvedValue(null);
    vi.mocked(planStockActions).mockReturnValue(
      plan(Array.from({ length: 155 }, (_, i) => action({ shopifyProductId: String(i), action: "oos" }))) as never,
    );

    const b = await body(await GET(req()));

    expect(b.data!.skipped).toBe(155);
    expect(b.data!.deferred).toBe(0);
    expect(updateShopifyProduct).not.toHaveBeenCalled();
  });
});

describe("degradation", () => {
  it("keeps doing rupture detection when the draft-states fetch fails", async () => {
    // Reactivation is the least critical feature — a Shopify hiccup there must not abort
    // the OOS/draft pass.
    vi.mocked(fetchDraftProductStates).mockRejectedValue(new Error("Shopify 500"));
    vi.mocked(planStockActions).mockReturnValue(plan([action({ action: "oos" })]) as never);

    const b = await body(await GET(req()));

    expect(b.success).toBe(true);
    expect(b.data!.wentOOS).toBe(1);
    // Degraded to "no reactivation candidates" rather than throwing.
    expect(vi.mocked(planStockActions).mock.calls[0][0].autoDraftedIds!.size).toBe(0);
  });

  it("counts one product's failure and carries on with the rest", async () => {
    vi.mocked(getShopifyStockState)
      .mockRejectedValueOnce(new Error("Shopify timeout"))
      .mockResolvedValue(state());
    vi.mocked(planStockActions).mockReturnValue(
      plan([
        action({ shopifyProductId: "bad", action: "oos" }),
        action({ shopifyProductId: "good", action: "oos" }),
      ]) as never,
    );

    const b = await body(await GET(req()));

    expect(b.data!.errors).toBe(1);
    expect(b.data!.wentOOS).toBe(1);
  });

  it("500s when the CSV fetch itself fails", async () => {
    vi.mocked(fetchAosomCatalog).mockRejectedValue(new Error("Aosom down"));

    const res = await GET(req());

    expect(res.status).toBe(500);
    expect((await body(res)).success).toBe(false);
  });
});

describe("baseline persistence", () => {
  it("writes the flipped product's baseline right after its own write, not batched at the end", async () => {
    const order: string[] = [];
    vi.mocked(updateShopifyProduct).mockImplementation(async (id: string) => { order.push(`shopify:${id}`); });
    vi.mocked(updateStockBaselineQty).mockImplementation(async (u) => {
      order.push(`baseline:${(u as Array<{ sku: string }>)[0].sku}`);
    });
    vi.mocked(planStockActions).mockReturnValue(
      plan(
        [
          action({ shopifyProductId: "A", skus: ["SKU-A"], action: "oos" }),
          action({ shopifyProductId: "B", skus: ["SKU-B"], action: "oos" }),
        ],
        [{ sku: "SKU-A", qty: 0 }, { sku: "SKU-B", qty: 0 }],
      ) as never,
    );

    await GET(req());

    // Interleaved, so a budget-killed run keeps the progress it already made.
    expect(order).toEqual(["shopify:A", "baseline:SKU-A", "shopify:B", "baseline:SKU-B"]);
  });

  it("writes no baseline for a drafted product, which is absent from the feed", async () => {
    vi.mocked(planStockActions).mockReturnValue(
      plan([action({ shopifyProductId: "A", skus: ["SKU-GONE"], action: "draft" })], []) as never,
    );

    await GET(req());

    expect(updateStockBaselineQty).not.toHaveBeenCalled();
  });
});
