// The `import` pool (automatic daily import) and withBudgetPool(): a call tree can be redirected off the
// shared `batch` pool without threading a pool argument through every caller, and only `batch` is
// redirected — pools a caller names on purpose are left alone.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({ used: {} as Record<string, number>, added: [] as Array<{ pool: string; n: number }> }));
vi.mock("@/lib/database", () => ({
  getDailyLlmTokensUsed: async (pool: string) => state.used[pool] ?? 0,
  addDailyLlmTokens: async (pool: string, n: number) => {
    state.added.push({ pool, n });
    state.used[pool] = (state.used[pool] ?? 0) + n;
  },
}));

const { budgetedCreate, withBudgetPool, poolBudget, LlmBudgetExceededError } = await import("@/lib/llm-budget");

const fakeClient = {
  messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 100, output_tokens: 50 } })) },
} as never;
const params = { model: "claude-haiku-4-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] } as never;

beforeEach(() => {
  state.used = {};
  state.added = [];
  delete process.env.LLM_IMPORT_DAILY_BUDGET;
});
afterEach(() => vi.clearAllMocks());

describe("import pool", () => {
  it("has its own default budget and env override", () => {
    expect(poolBudget("import")).toBe(3_000_000);
    process.env.LLM_IMPORT_DAILY_BUDGET = "4500000";
    expect(poolBudget("import")).toBe(4_500_000);
  });

  it("charges the import pool for every default-pool call inside withBudgetPool", async () => {
    await withBudgetPool("import", async () => {
      await budgetedCreate(fakeClient, params);
      await budgetedCreate(fakeClient, params, undefined, "batch"); // the vision classifier names "batch" explicitly
    });
    expect(state.added).toEqual([{ pool: "import", n: 150 }, { pool: "import", n: 150 }]);
  });

  it("leaves pools named on purpose alone", async () => {
    await withBudgetPool("import", () => budgetedCreate(fakeClient, params, undefined, "assistant"));
    expect(state.added).toEqual([{ pool: "assistant", n: 150 }]);
  });

  it("charges batch outside withBudgetPool, and never leaks the override", async () => {
    await withBudgetPool("import", async () => {});
    await budgetedCreate(fakeClient, params);
    expect(state.added).toEqual([{ pool: "batch", n: 150 }]);
  });

  it("an exhausted import pool blocks import calls but not the shared batch pool", async () => {
    state.used.import = 3_000_000;
    await expect(withBudgetPool("import", () => budgetedCreate(fakeClient, params))).rejects.toBeInstanceOf(LlmBudgetExceededError);
    await expect(budgetedCreate(fakeClient, params)).resolves.toBeDefined();
  });
});
