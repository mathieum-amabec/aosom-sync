// CSO Finding 2: daily Anthropic token budget (fail-closed), split into independent
// pools ('assistant' vs 'batch'). Tests the budget logic in isolation by stubbing the
// per-pool DB counter helpers (the real ones go through the database.ts module
// singleton, which can't point at :memory:).
import { describe, it, expect, vi, beforeEach } from "vitest";

// Per-pool in-memory counter standing in for the daily_llm_budget (day, pool) table.
const state = vi.hoisted(() => ({
  used: { assistant: 0, batch: 0, maintenance: 0 } as Record<string, number>,
  added: [] as Array<{ pool: string; n: number }>,
  /** Set to simulate the counter write failing (a Turso blip), to prove it is LOGGED. */
  failAdd: null as Error | null,
}));
vi.mock("@/lib/database", () => ({
  getDailyLlmTokensUsed: async (pool: string) => state.used[pool] ?? 0,
  addDailyLlmTokens: async (pool: string, n: number) => {
    if (state.failAdd) throw state.failAdd;
    state.added.push({ pool, n });
    state.used[pool] = (state.used[pool] ?? 0) + n;
  },
}));

const {
  assertLlmBudget,
  recordLlmUsage,
  budgetedCreate,
  dailyTokenBudget,
  poolBudget,
  LlmBudgetExceededError,
} = await import("@/lib/llm-budget");

beforeEach(() => {
  state.used.assistant = 0;
  state.used.batch = 0;
  state.used.maintenance = 0;
  state.added.length = 0;
  state.failAdd = null;
  delete process.env.LLM_MAINTENANCE_DAILY_BUDGET;
  delete process.env.LLM_DAILY_TOKEN_BUDGET;
  delete process.env.LLM_ASSISTANT_DAILY_BUDGET;
});

describe("llm-budget pools", () => {
  it("batch default is 1.3M (LLM_DAILY_TOKEN_BUDGET); env overrides", () => {
    expect(poolBudget("batch")).toBe(1_300_000);
    expect(dailyTokenBudget()).toBe(1_300_000); // alias for the batch pool
    process.env.LLM_DAILY_TOKEN_BUDGET = "1000";
    expect(poolBudget("batch")).toBe(1000);
    process.env.LLM_DAILY_TOKEN_BUDGET = "not-a-number";
    expect(poolBudget("batch")).toBe(1_300_000);
  });

  it("assistant default is 500k (LLM_ASSISTANT_DAILY_BUDGET); env overrides", () => {
    expect(poolBudget("assistant")).toBe(500_000);
    process.env.LLM_ASSISTANT_DAILY_BUDGET = "500";
    expect(poolBudget("assistant")).toBe(500);
    process.env.LLM_ASSISTANT_DAILY_BUDGET = "0"; // invalid → fallback
    expect(poolBudget("assistant")).toBe(500_000);
  });

  it("assertLlmBudget passes under the pool budget, throws at/over (fail-closed)", async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = "100";
    state.used.batch = 99;
    await expect(assertLlmBudget("batch")).resolves.toBeUndefined();
    state.used.batch = 100;
    await expect(assertLlmBudget("batch")).rejects.toBeInstanceOf(LlmBudgetExceededError);
    state.used.batch = 250;
    await expect(assertLlmBudget("batch")).rejects.toThrow(/pool "batch".*budget exceeded|budget exceeded.*"batch"/);
  });

  it("POOL ISOLATION: an exhausted batch pool does NOT block the assistant pool", async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = "100"; // batch
    process.env.LLM_ASSISTANT_DAILY_BUDGET = "100"; // assistant
    state.used.batch = 100_000; // batch blown wide past its cap (a bulk import)
    state.used.assistant = 0;
    // batch is refused…
    await expect(assertLlmBudget("batch")).rejects.toBeInstanceOf(LlmBudgetExceededError);
    // …but the public assistant is unaffected.
    await expect(assertLlmBudget("assistant")).resolves.toBeUndefined();
  });

  it("POOL ISOLATION: an exhausted assistant pool does NOT block batch", async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = "100";
    process.env.LLM_ASSISTANT_DAILY_BUDGET = "100";
    state.used.assistant = 100;
    await expect(assertLlmBudget("assistant")).rejects.toBeInstanceOf(LlmBudgetExceededError);
    await expect(assertLlmBudget("batch")).resolves.toBeUndefined();
  });

  it("fails OPEN when the budget store is unreachable (infra error)", async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = "1";
    const spy = vi.spyOn(await import("@/lib/database"), "getDailyLlmTokensUsed").mockRejectedValueOnce(
      new Error("turso down"),
    );
    await expect(assertLlmBudget("batch")).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("recordLlmUsage adds input+output tokens to the named pool; ignores empty/null", async () => {
    await recordLlmUsage("assistant", { input_tokens: 10, output_tokens: 5 } as never);
    expect(state.added).toEqual([{ pool: "assistant", n: 15 }]);
    await recordLlmUsage("batch", null);
    await recordLlmUsage("batch", { input_tokens: 0, output_tokens: 0 } as never);
    expect(state.added).toEqual([{ pool: "assistant", n: 15 }]);
    expect(state.used.batch).toBe(0);
  });

  it("budgetedCreate DEFAULTS to the batch pool (asserts before, records after)", async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = "1000";
    const client = {
      messages: {
        create: vi.fn(async () => ({ usage: { input_tokens: 100, output_tokens: 50 }, content: [] })),
      },
    };
    const msg = await budgetedCreate(client as never, { model: "x", max_tokens: 1, messages: [] } as never);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(state.added).toEqual([{ pool: "batch", n: 150 }]);
    expect((msg as { usage: { input_tokens: number } }).usage.input_tokens).toBe(100);
  });

  it("budgetedCreate debits the ASSISTANT pool when pool='assistant'", async () => {
    process.env.LLM_ASSISTANT_DAILY_BUDGET = "1000";
    const client = {
      messages: { create: vi.fn(async () => ({ usage: { input_tokens: 30, output_tokens: 20 }, content: [] })) },
    };
    await budgetedCreate(client as never, { model: "x", max_tokens: 1, messages: [] } as never, undefined, "assistant");
    expect(state.added).toEqual([{ pool: "assistant", n: 50 }]);
    expect(state.used.batch).toBe(0); // batch untouched
  });

  it("budgetedCreate fails closed WITHOUT calling the API when the pool is over budget", async () => {
    process.env.LLM_ASSISTANT_DAILY_BUDGET = "100";
    state.used.assistant = 100;
    const client = { messages: { create: vi.fn() } };
    await expect(
      budgetedCreate(client as never, {} as never, undefined, "assistant"),
    ).rejects.toThrow(/budget exceeded/);
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});

// ─── The `maintenance` pool actually increments its counter ───────────────────
// Context (2026-09-11): the pool read zero for its first two days and was assumed broken. It
// was not — the 1,730-product audit finished 12 minutes BEFORE the pool existed, so it had
// simply never run a call. These tests pin the wiring so a real regression can't hide behind
// that story next time.
describe("maintenance pool accounting", () => {
  const clientReturning = (input_tokens: number, output_tokens: number) => ({
    messages: { create: vi.fn(async () => ({ usage: { input_tokens, output_tokens }, content: [] })) },
  });

  it("budgetedCreate debits the MAINTENANCE pool when pool='maintenance'", async () => {
    const client = clientReturning(870, 85);

    await budgetedCreate(client as never, { model: "x", max_tokens: 1, messages: [] } as never, undefined, "maintenance");

    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(state.added).toEqual([{ pool: "maintenance", n: 955 }]);
    expect(state.used.maintenance).toBe(955);
  });

  it("keeps maintenance spend OUT of the production pools", async () => {
    await budgetedCreate(clientReturning(900, 100) as never, {} as never, undefined, "maintenance");

    // The whole point of the third pool: a catalogue pass can never starve imports/blog/social.
    expect(state.used.batch).toBe(0);
    expect(state.used.assistant).toBe(0);
    expect(state.used.maintenance).toBe(1000);
  });

  it("accumulates across calls, the way a full audit does", async () => {
    for (let i = 0; i < 3; i++) {
      await budgetedCreate(clientReturning(870, 85) as never, {} as never, undefined, "maintenance");
    }

    expect(state.used.maintenance).toBe(2865);
    expect(state.added).toHaveLength(3);
  });

  it("recordLlmUsage writes a maintenance usage straight through", async () => {
    await recordLlmUsage("maintenance", { input_tokens: 12, output_tokens: 3 } as never);

    expect(state.added).toEqual([{ pool: "maintenance", n: 15 }]);
  });

  it("is UNCAPPED by default but capped when LLM_MAINTENANCE_DAILY_BUDGET is set", async () => {
    expect(poolBudget("maintenance")).toBe(Infinity);
    process.env.LLM_MAINTENANCE_DAILY_BUDGET = "500";
    expect(poolBudget("maintenance")).toBe(500);

    state.used.maintenance = 500;
    await expect(
      budgetedCreate(clientReturning(1, 1) as never, {} as never, undefined, "maintenance"),
    ).rejects.toThrow(/pool "maintenance"/);
  });
});

describe("a failed counter write is logged, never swallowed", () => {
  it("logs UNRECORDED SPEND with the pool and the token count, and still returns the message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    state.failAdd = new Error("SQLITE_BUSY: database is locked");
    const client = {
      messages: { create: vi.fn(async () => ({ usage: { input_tokens: 870, output_tokens: 85 }, content: [] })) },
    };

    // The generation is already paid for — a bookkeeping failure must not throw it away.
    const msg = await budgetedCreate(client as never, {} as never, undefined, "maintenance");
    expect(msg).toBeDefined();

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(line).toContain("UNRECORDED SPEND");
    expect(line).toContain("955 token(s)");   // enough to reconstruct the lost increment
    expect(line).toContain('pool "maintenance"');
    expect(line).toContain("in=870");
    expect(line).toContain("out=85");
    expect(line).toContain("SQLITE_BUSY");    // the cause, not just the symptom
    spy.mockRestore();
  });

  it("logs the same way for the production pools", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    state.failAdd = new Error("network down");

    await budgetedCreate(
      { messages: { create: vi.fn(async () => ({ usage: { input_tokens: 5, output_tokens: 5 }, content: [] })) } } as never,
      {} as never,
    );

    expect(spy.mock.calls[0][0]).toContain('pool "batch"');
    spy.mockRestore();
  });
});
