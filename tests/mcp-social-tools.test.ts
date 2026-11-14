import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseScopes } from "@/lib/mcp/scopes";

const job = vi.hoisted(() => ({ runStockHighlight: vi.fn(), triggerNewProduct: vi.fn(), triggerPriceDrop: vi.fn() }));
vi.mock("@/jobs/job4-social", () => job);

const { SOCIAL_TOOLS, MAX_DRAFTS_PER_DAY } = await import("@/lib/mcp/social-tools");
const generate = SOCIAL_TOOLS.find((t) => t.name === "social_generate")!;
const list = SOCIAL_TOOLS.find((t) => t.name === "social_drafts")!;

function fakeDb(opts: { recent?: number; listed?: boolean; known?: boolean } = {}) {
  const execute = vi.fn(async ({ sql }: { sql: string }) => {
    if (/COUNT\(\*\) AS n FROM cron_runs/.test(sql)) return { rows: [{ n: opts.recent ?? 0 }] };
    if (/FROM products WHERE sku/.test(sql)) return { rows: opts.known === false ? [] : [{ shopify_product_id: opts.listed === false ? null : "123" }] };
    return { rows: [] };
  });
  return { execute };
}
const draft = (id: number) => ({ draftId: id, postText: `FR ${id}`, postTextEn: `EN ${id}`, imageUrl: "https://img/x.jpg", imagePath: null, imageUrls: [] });

describe("social permission", () => {
  it("is opt-in and parsed from the scope string", () => {
    expect(parseScopes("read").has("social")).toBe(false);
    expect(parseScopes("read social").has("social")).toBe(true);
    expect(SOCIAL_TOOLS.every((t) => t.scope === "social")).toBe(true);
  });
  it("has no approve / schedule / publish tool", () => {
    expect(SOCIAL_TOOLS.map((t) => t.name).join(" ")).not.toMatch(/approve|schedule|publish\b|reject/);
  });
});

describe("social_generate", () => {
  beforeEach(() => Object.values(job).forEach((m) => m.mockReset()));

  it("highlight: creates drafts through the dashboard generator, logs each, and says where to approve", async () => {
    job.runStockHighlight.mockResolvedValue({ drafts: [draft(1), draft(2)] });
    const db = fakeDb();
    const out = (await generate.handler(db as never, { kind: "highlight", count: 9, category: "all" })) as { created: number; drafts: { draft_id: number }[]; review: string };
    expect(job.runStockHighlight).toHaveBeenCalledWith(3, "all"); // count clamped to 3
    expect(out.created).toBe(2);
    expect(out.review).toMatch(/Aosom-sync → Social/);
    const logs = (db.execute.mock.calls as unknown as [{ sql: string }][]).filter(([s]) => /INSERT INTO cron_runs/.test(s.sql));
    expect(logs).toHaveLength(2);
  });
  it("highlight: unknown category is an error; an empty run is explained, not thrown", async () => {
    await expect(generate.handler(fakeDb() as never, { kind: "highlight", category: "nope-nope" })).rejects.toThrow(/Catégorie inconnue/);
    job.runStockHighlight.mockResolvedValue({ drafts: [], emptyReason: "cooldown", cooldownDays: 30 });
    const out = (await generate.handler(fakeDb() as never, { kind: "highlight" })) as { created: number; note: string };
    expect(out.created).toBe(0);
    expect(out.note).toMatch(/post récent/);
  });
  it("new_product / price_drop: only for products already on the store; price_drop needs a real drop", async () => {
    await expect(generate.handler(fakeDb({ known: false }) as never, { kind: "new_product", sku: "X" })).rejects.toThrow(/introuvable/);
    await expect(generate.handler(fakeDb({ listed: false }) as never, { kind: "new_product", sku: "X" })).rejects.toThrow(/pas encore importé/);
    await expect(generate.handler(fakeDb() as never, { kind: "price_drop", sku: "X", old_price: 10, new_price: 12 })).rejects.toThrow(/new_price < old_price/);
    job.triggerPriceDrop.mockResolvedValue(draft(7));
    const out = (await generate.handler(fakeDb() as never, { kind: "price_drop", sku: "X", old_price: 100, new_price: 80 })) as { created: number };
    expect(job.triggerPriceDrop).toHaveBeenCalledWith("X", 100, 80);
    expect(out.created).toBe(1);
  });
  it("enforces the daily cap before generating anything", async () => {
    await expect(generate.handler(fakeDb({ recent: MAX_DRAFTS_PER_DAY }) as never, { kind: "highlight" })).rejects.toThrow(/Plafond/);
    expect(job.runStockHighlight).not.toHaveBeenCalled();
  });
});

describe("social_drafts", () => {
  it("lists drafts with a bound status filter and a limit cap", async () => {
    const db = fakeDb();
    await list.handler(db as never, { status: "draft'; DROP TABLE x;--", limit: 999 });
    const [stmt] = db.execute.mock.calls[0] as unknown as [{ sql: string; args: unknown[] }];
    expect(stmt.sql).toMatch(/^\s*select/i);
    expect(stmt.sql).toMatch(/LIMIT 15\b/);
    expect(stmt.args).toEqual(["draft"]);
  });
});
