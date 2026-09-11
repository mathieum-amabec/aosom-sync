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

/**
 * Resolve a pool's daily token budget from its env var, falling back to the default.
 *
 * `maintenance` is UNCAPPED by default (Infinity). It exists so a deliberate,
 * operator-launched catalogue pass — a full pos-1 image audit is ~2,500 vision calls, roughly
 * two days of the whole `batch` cap — can run without starving imports, blog and social
 * generation, while its tokens are still COUNTED and shown on the usage dashboard. A silent
 * bypass would have hidden that spend entirely. Set `LLM_MAINTENANCE_DAILY_BUDGET` to cap it.
 */
export function poolBudget(pool: BudgetPool): number {
  if (pool === "maintenance") {
    const raw = Number(process.env.LLM_MAINTENANCE_DAILY_BUDGET);
    return Number.isFinite(raw) && raw > 0 ? raw : Infinity;
  }
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
    const envName =
      pool === "assistant" ? "LLM_ASSISTANT_DAILY_BUDGET"
      : pool === "maintenance" ? "LLM_MAINTENANCE_DAILY_BUDGET"
      : "LLM_DAILY_TOKEN_BUDGET";
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
 * Why the `maintenance` counter read zero for its first two days — for the next person who
 * finds an empty row and concludes the write path is broken (investigated 2026-09-11):
 *
 * It was not broken. The 1,730-product pos-1 audit FINISHED at 20:43 local; the commit that
 * introduced this pool landed at 20:55. The entire audit therefore billed `batch` — which is
 * precisely why it blew the 1.3M cap, blocked imports/blog/social, and had to be zeroed by
 * hand mid-run. The pool was the REMEDY, written after the incident, and had simply never
 * run a call. Verified against production that same day: both `addDailyLlmTokens` and
 * `recordLlmUsage` increment `daily_llm_budget` correctly for pool "maintenance".
 *
 * An empty counter and a broken counter now look different from outside: a failed write logs
 * "UNRECORDED SPEND" from `budgetedCreate` below, with the token count, instead of vanishing
 * into an empty catch block.
 */

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
  } catch (err) {
    // Bookkeeping stays best-effort — a counter write must never fail an already-paid-for
    // generation — but it is NEVER silent again. A swallowed failure here is real spend that
    // no counter and no dashboard will ever show, findable only by reconciling the Anthropic
    // console by hand. This line carries everything needed to reconstruct the lost
    // increment: the pool, the exact token split, and the cause.
    const inTok = message.usage?.input_tokens ?? 0;
    const outTok = message.usage?.output_tokens ?? 0;
    console.error(
      `[llm-budget] UNRECORDED SPEND — failed to write ${inTok + outTok} token(s) to pool ` +
        `"${pool}" (in=${inTok} out=${outTok}). The call SUCCEEDED and Anthropic bills it, ` +
        `but daily_llm_budget is now short by that amount: ` +
        `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
    );
  }
  return message;
}
