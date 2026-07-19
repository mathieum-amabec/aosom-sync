/**
 * Global Anthropic spend guardrail (CSO Finding 2).
 *
 * Every Claude call goes through `budgetedCreate()`, which:
 *   1. asserts today's (UTC) token usage is under the daily budget, FAIL-CLOSED
 *      (throws) when the budget is exhausted, and
 *   2. records the call's actual input+output tokens against today's counter.
 *
 * The counter is persisted in Turso (`daily_llm_budget`, keyed by UTC date), so
 * the cap holds ACROSS Vercel Fluid Compute instances — unlike the per-process
 * in-memory `checkRateLimit`, which resets on cold start and multiplies per
 * instance. The budget is a financial backstop against a leaked credential or a
 * runaway loop driving unbounded Anthropic spend, not a per-user rate limit.
 *
 * Threshold: `LLM_DAILY_TOKEN_BUDGET` env var (default 500_000 tokens/day).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { getDailyLlmTokensUsed, addDailyLlmTokens } from "@/lib/database";

const DEFAULT_DAILY_TOKEN_BUDGET = 500_000;

/** Resolve the daily token budget from env, falling back to the default. */
export function dailyTokenBudget(): number {
  const raw = Number(process.env.LLM_DAILY_TOKEN_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_TOKEN_BUDGET;
}

export class LlmBudgetExceededError extends Error {
  constructor(used: number, budget: number) {
    super(
      `LLM daily token budget exceeded (${used}/${budget} tokens used today, UTC) — ` +
        `refusing further Claude calls until 00:00 UTC. Raise LLM_DAILY_TOKEN_BUDGET to override.`,
    );
    this.name = "LlmBudgetExceededError";
  }
}

/**
 * Throw (fail-closed) when today's LLM token usage has reached the daily budget.
 * Fails OPEN only when the budget store itself is unreachable — a financial
 * backstop must not take down all content generation on a transient DB blip
 * (the runaway-loop / leaked-credential threat it guards keeps the counter
 * incrementing normally, so the cap still fires in that case).
 */
export async function assertLlmBudget(): Promise<void> {
  const budget = dailyTokenBudget();
  let used: number;
  try {
    used = await getDailyLlmTokensUsed();
  } catch (err) {
    console.warn(
      `[llm-budget] budget read failed — allowing call (fail-open on infra error): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (used >= budget) throw new LlmBudgetExceededError(used, budget);
}

/** Record an Anthropic call's token usage against today's budget counter. */
export async function recordLlmUsage(
  usage: Anthropic.Messages.Usage | null | undefined,
): Promise<void> {
  const total = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
  if (total > 0) await addDailyLlmTokens(total);
}

/**
 * Budget-gated `client.messages.create(...)`. Asserts the daily budget BEFORE the
 * call (fail-closed) and records usage AFTER. Use this in place of every direct
 * `client.messages.create(...)`. Recording failures are swallowed — a bookkeeping
 * write must never fail an already-successful generation.
 */
export async function budgetedCreate(
  client: Anthropic,
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  options?: Anthropic.RequestOptions,
): Promise<Anthropic.Messages.Message> {
  await assertLlmBudget();
  const message = await client.messages.create(params, options);
  try {
    await recordLlmUsage(message.usage);
  } catch {
    /* budget bookkeeping is best-effort; never fail a successful generation */
  }
  return message;
}
