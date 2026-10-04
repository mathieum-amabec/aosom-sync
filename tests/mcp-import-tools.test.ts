import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.SESSION_SECRET = "test-secret-for-plans";

const pipeline = vi.hoisted(() => ({ queueForImport: vi.fn(), generateContent: vi.fn(), importToShopify: vi.fn() }));
vi.mock("@/lib/import-pipeline", () => pipeline);
const notify = vi.hoisted(() => vi.fn(async () => 1));
vi.mock("@/lib/database", () => ({ createNotification: notify }));

const { IMPORT_TOOLS, signPlan, verifyPlan, MAX_SKUS_PER_PLAN, MAX_IMPORTS_PER_DAY } = await import("@/lib/mcp/import-tools");
const preview = IMPORT_TOOLS.find((t) => t.name === "import_preview")!;
const confirm = IMPORT_TOOLS.find((t) => t.name === "import_confirm")!;

/** Fake DB: answers SELECTs from canned tables and records INSERTs. */
function fakeDb(opts: { products?: Record<string, unknown>[]; costway?: boolean; recentImports?: number } = {}) {
  const execute = vi.fn(async ({ sql }: { sql: string }) => {
    if (/FROM products WHERE sku IN/.test(sql)) return { rows: opts.products ?? [] };
    if (/FROM costway_products/.test(sql)) return { rows: opts.costway ? [{ item_no: "1" }] : [] };
    if (/COUNT\(\*\) AS n FROM cron_runs/.test(sql)) return { rows: [{ n: opts.recentImports ?? 0 }] };
    return { rows: [] };
  });
  return { execute };
}
const prod = (sku: string, over: Record<string, unknown> = {}) => ({ sku, name: `Item ${sku}`, price: 100, qty: 5, color: "Grey", product_type: "Patio", shopify_product_id: null, ...over });

describe("signed import plans", () => {
  it("round-trips, rejects tampering and expiry, and binds the exact SKU list", () => {
    const plan = signPlan(["B", "A"]);
    expect(verifyPlan(plan)).toEqual(["A", "B"]);
    const [payload, sig] = plan.split(".");
    const forged = Buffer.from(JSON.stringify({ skus: ["EVIL"], exp: 9_999_999_999 })).toString("base64url");
    expect(() => verifyPlan(`${forged}.${sig}`)).toThrow(/invalide/);
    expect(() => verifyPlan(`${payload}.x${sig}`)).toThrow(/invalide/);
    expect(() => verifyPlan(plan, Math.floor(Date.now() / 1000) + 3600)).toThrow(/expiré/);
    expect(() => verifyPlan("garbage")).toThrow(/invalide/);
  });
});

describe("import_preview", () => {
  it("creates nothing, flags refusals and warnings, and signs a plan for the importable SKUs only", async () => {
    const db = fakeDb({ products: [prod("A-1"), prod("B-2", { shopify_product_id: "999" }), prod("C-3", { qty: 0 })] });
    const out = (await preview.handler(db as never, { skus: ["A-1", "B-2", "C-3", "NOPE"] })) as { importable: number; items: { sku: string; status: string; reason?: string; warnings?: string[] }[]; plan_id: string };
    expect(out.items.find((i) => i.sku === "B-2")).toMatchObject({ status: "refused", reason: "Déjà importé" });
    expect(out.items.find((i) => i.sku === "NOPE")?.status).toBe("refused");
    expect(out.items.find((i) => i.sku === "C-3")?.warnings?.[0]).toMatch(/Rupture/);
    expect(out.importable).toBe(2);
    expect(verifyPlan(out.plan_id)).toEqual(["A-1", "C-3"]);
    expect(pipeline.queueForImport).not.toHaveBeenCalled(); // nothing written, nothing queued
    for (const [stmt] of db.execute.mock.calls as unknown as [{ sql: string }][]) expect(stmt.sql).toMatch(/^\s*select/i);
  });
  it("refuses Costway SKUs with a pointer to the right importer", async () => {
    const out = (await preview.handler(fakeDb({ costway: true }) as never, { skus: ["02956471_X"] })) as { items: { reason: string }[]; plan_id: string | null };
    expect(out.items[0].reason).toMatch(/Costway/);
    expect(out.plan_id).toBeNull();
  });
  it(`caps a plan at ${MAX_SKUS_PER_PLAN} SKUs and rejects junk input`, async () => {
    await expect(preview.handler(fakeDb() as never, { skus: Array.from({ length: MAX_SKUS_PER_PLAN + 1 }, (_, i) => `S${i}`) })).rejects.toThrow(/Maximum/);
    await expect(preview.handler(fakeDb() as never, { skus: [] })).rejects.toThrow();
    await expect(preview.handler(fakeDb() as never, { skus: "A-1" })).rejects.toThrow();
  });
});

describe("import_confirm", () => {
  beforeEach(() => { Object.values(pipeline).forEach((m) => m.mockReset()); notify.mockClear(); });

  it("rejects a missing / forged plan before touching the pipeline", async () => {
    await expect(confirm.handler(fakeDb() as never, { plan_id: "nope" })).rejects.toThrow(/invalide/);
    expect(pipeline.queueForImport).not.toHaveBeenCalled();
  });
  it("enforces the daily cap", async () => {
    const db = fakeDb({ recentImports: MAX_IMPORTS_PER_DAY });
    await expect(confirm.handler(db as never, { plan_id: signPlan(["A-1"]) })).rejects.toThrow(/Plafond/);
    expect(pipeline.queueForImport).not.toHaveBeenCalled();
  });
  it("runs queue → generate → push per job, logs each SKU and notifies", async () => {
    const db = fakeDb();
    pipeline.queueForImport.mockResolvedValue({ jobs: [{ id: "j1", groupKey: "G1" }, { id: "j2", groupKey: "G2" }], skipped: [{ sku: "Z", reason: "already_imported" }] });
    pipeline.generateContent.mockResolvedValue({});
    pipeline.importToShopify.mockResolvedValueOnce({ status: "done", shopifyId: "111", error: null }).mockRejectedValueOnce(new Error("Shopify 422"));
    const out = (await confirm.handler(db as never, { plan_id: signPlan(["A-1", "A-2"]) })) as { imported: number; results: { outcome: string }[] };
    expect(out.imported).toBe(1);
    expect(out.results.map((r) => r.outcome)).toEqual(["skipped", "done", "error"]);
    expect(pipeline.generateContent).toHaveBeenCalledTimes(2);
    const logged = (db.execute.mock.calls as unknown as [{ sql: string }][]).filter(([s]) => /INSERT INTO cron_runs/.test(s.sql));
    expect(logged).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
