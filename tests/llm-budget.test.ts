// CSO Finding 2: global daily Anthropic token budget (fail-closed). Tests the
// budget logic in isolation by stubbing the DB counter helpers (the real ones go
// through the database.ts module singleton, which can't point at :memory:).
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ used: 0, added: [] as number[] }));
vi.mock("@/lib/database", () => ({
  getDailyLlmTokensUsed: async () => state.used,
  addDailyLlmTokens: async (n: number) => {
    state.added.push(n);
    state.used += n;
  },
}));

const { assertLlmBudget, recordLlmUsage, budgetedCreate, dailyTokenBudget, LlmBudgetExceededError } =
  await import("@/lib/llm-budget");

beforeEach(() => {
  state.used = 0;
  state.added.length = 0;
  delete process.env.LLM_DAILY_TOKEN_BUDGET;
});

describe("llm-budget", () => {
  it("default budget is 500k tokens; env overrides", () => {
    expect(dailyTokenBudget()).toBe(500_000);
    process.env.LLM_DAILY_TOKEN_BUDGET = "1000";
    expect(dailyTokenBudget()).toBe(1000);
    process.env.LLM_DAILY_TOKEN_BUDGET = "not-a-number";
    expect(dailyTokenBudget()).toBe(500_000);
  });

  it("assertLlmBudget passes under budget, throws at/over (fail-closed)", async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = "100";
    state.used = 99;
    await expect(assertLlmBudget()).resolves.toBeUndefined();
    state.used = 100;
    await expect(assertLlmBudget()).rejects.toBeInstanceOf(LlmBudgetExceededError);
    state.used = 250;
    await expect(assertLlmBudget()).rejects.toThrow(/budget exceeded/);
  });

  it("fails OPEN when the budget store is unreachable (infra error)", async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = "1";
    const spy = vi.spyOn(await import("@/lib/database"), "getDailyLlmTokensUsed").mockRejectedValueOnce(
      new Error("turso down"),
    );
    await expect(assertLlmBudget()).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("recordLlmUsage adds input+output tokens; ignores empty/null", async () => {
    await recordLlmUsage({ input_tokens: 10, output_tokens: 5 } as never);
    expect(state.added).toEqual([15]);
    await recordLlmUsage(null);
    await recordLlmUsage({ input_tokens: 0, output_tokens: 0 } as never);
    expect(state.added).toEqual([15]);
  });

  it("budgetedCreate asserts before, calls the API, records after", async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = "1000";
    const client = {
      messages: {
        create: vi.fn(async () => ({ usage: { input_tokens: 100, output_tokens: 50 }, content: [] })),
      },
    };
    const msg = await budgetedCreate(client as never, { model: "x", max_tokens: 1, messages: [] } as never);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(state.added).toEqual([150]);
    expect((msg as { usage: { input_tokens: number } }).usage.input_tokens).toBe(100);
  });

  it("budgetedCreate fails closed WITHOUT calling the API when over budget", async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = "100";
    state.used = 100;
    const client = { messages: { create: vi.fn() } };
    await expect(budgetedCreate(client as never, {} as never)).rejects.toThrow(/budget exceeded/);
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});
