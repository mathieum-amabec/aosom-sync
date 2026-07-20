// CSO Finding 2: daily Anthropic token budget (fail-closed), split into independent
// pools ('assistant' vs 'batch'). Tests the budget logic in isolation by stubbing the
// per-pool DB counter helpers (the real ones go through the database.ts module
// singleton, which can't point at :memory:).
import { describe, it, expect, vi, beforeEach } from "vitest";

// Per-pool in-memory counter standing in for the daily_llm_budget (day, pool) table.
const state = vi.hoisted(() => ({
  used: { assistant: 0, batch: 0 } as Record<string, number>,
  added: [] as Array<{ pool: string; n: number }>,
}));
vi.mock("@/lib/database", () => ({
  getDailyLlmTokensUsed: async (pool: string) => state.used[pool] ?? 0,
  addDailyLlmTokens: async (pool: string, n: number) => {
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
  state.added.length = 0;
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

  it("assistant default is 200k (LLM_ASSISTANT_DAILY_BUDGET); env overrides", () => {
    expect(poolBudget("assistant")).toBe(200_000);
    process.env.LLM_ASSISTANT_DAILY_BUDGET = "500";
    expect(poolBudget("assistant")).toBe(500);
    process.env.LLM_ASSISTANT_DAILY_BUDGET = "0"; // invalid → fallback
    expect(poolBudget("assistant")).toBe(200_000);
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
