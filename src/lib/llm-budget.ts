/**
 * Anthropic spend guardrail (CSO Finding 2), split into independent daily pools.
 *
 * Every Claude call goes through `budgetedCreate()`, which:
 *   1. asserts its POOL's today (UTC) token usage is under that pool's budget,
 *      FAIL-CLOSED (throws) when the pool is exhausted, and
 *   2. records the call's actual input+output tokens against that pool's counter.
 *
 * Two pools, so a bulk run can never starve the public storefront:
 *   - `assistant` — ONLY `/api/assistant` (the public shopping assistant). Budget:
 *     `LLM_ASSISTANT_DAILY_BUDGET` (default 500k).
 *   - `batch` — everything else (imports, product/blog content, social captions,
 *     slideshow/video hooks, vision). Budget: `LLM_DAILY_TOKEN_BUDGET` (default 1.3M).
 * A bulk import drains only the `batch` pool, so the `assistant` pool — and shoppers —
 * are unaffected. `budgetedCreate` defaults to `batch`; only the assistant passes
 * `"assistant"`, so a new caller can never accidentally spend against the assistant pool.
 *
 * Counters live in Turso (`daily_llm_budget`, keyed by (UTC date, pool)), so the caps
 * hold ACROSS Vercel Fluid Compute instances — unlike the per-process in-memory
 * `checkRateLimit`, which resets on cold start and multiplies per instance. The budget
 * is a financial backstop against a leaked credential or a runaway loop, not a per-user
 * rate limit.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { getDailyLlmTokensUsed, addDailyLlmTokens, type LlmBudgetPool } from "@/lib/database";

export type BudgetPool = LlmBudgetPool;

const DEFAULT_BATCH_TOKEN_BUDGET = 1_300_000;
const DEFAULT_ASSISTANT_TOKEN_BUDGET = 500_000;

/** Resolve a pool's daily token budget from its env var, falling back to the default. */
export function poolBudget(pool: BudgetPool): number {
  const [envName, fallback] =
    pool === "assistant"
      ? ["LLM_ASSISTANT_DAILY_BUDGET", DEFAULT_ASSISTANT_TOKEN_BUDGET]
      : ["LLM_DAILY_TOKEN_BUDGET", DEFAULT_BATCH_TOKEN_BUDGET];
  const raw = Number(process.env[envName]);
  return Number.isFinite(raw) && raw > 0 ? raw : (fallback as number);
}

/** The batch pool's budget. Kept as a named export for callers/tests that read it directly. */
export function dailyTokenBudget(): number {
  return poolBudget("batch");
}

export class LlmBudgetExceededError extends Error {
  constructor(pool: BudgetPool, used: number, budget: number) {
    const envName = pool === "assistant" ? "LLM_ASSISTANT_DAILY_BUDGET" : "LLM_DAILY_TOKEN_BUDGET";
    super(
      `LLM daily token budget exceeded for pool "${pool}" (${used}/${budget} tokens used today, UTC) — ` +
        `refusing further Claude calls until 00:00 UTC. Raise ${envName} to override.`,
    );
    this.name = "LlmBudgetExceededError";
  }
}

/**
 * Throw (fail-closed) when the pool's today usage has reached its budget. Fails OPEN
 * only when the budget store itself is unreachable — a financial backstop must not
 * take down all content generation on a transient DB blip (the runaway-loop / leaked-
 * credential threat it guards keeps the counter incrementing normally, so the cap still
 * fires in that case).
 */
export async function assertLlmBudget(pool: BudgetPool): Promise<void> {
  const budget = poolBudget(pool);
  let used: number;
  try {
    used = await getDailyLlmTokensUsed(pool);
  } catch (err) {
    console.warn(
      `[llm-budget] budget read failed for pool "${pool}" — allowing call (fail-open on infra error): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (used >= budget) throw new LlmBudgetExceededError(pool, used, budget);
}

/** Record an Anthropic call's token usage against the given pool's counter. */
export async function recordLlmUsage(
  pool: BudgetPool,
  usage: Anthropic.Messages.Usage | null | undefined,
): Promise<void> {
  const total = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
  if (total > 0) await addDailyLlmTokens(pool, total);
}

/**
 * Budget-gated `client.messages.create(...)`. Asserts the pool's budget BEFORE the
 * call (fail-closed) and records usage AFTER. Use this in place of every direct
 * `client.messages.create(...)`. `pool` defaults to `"batch"`; ONLY the public
 * storefront assistant passes `"assistant"` — so a new caller can never accidentally
 * spend against (and exhaust) the assistant's reservation. Recording failures are
 * swallowed — a bookkeeping write must never fail an already-successful generation.
 */
export async function budgetedCreate(
  client: Anthropic,
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  options?: Anthropic.RequestOptions,
  pool: BudgetPool = "batch",
): Promise<Anthropic.Messages.Message> {
  await assertLlmBudget(pool);
  const message = await client.messages.create(params, options);
  try {
    await recordLlmUsage(pool, message.usage);
  } catch {
    /* budget bookkeeping is best-effort; never fail a successful generation */
  }
  return message;
}
