import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getLlmUsageWindow, type LlmBudgetPool } from "@/lib/database";
import { poolBudget } from "@/lib/llm-budget";
import { estimateCostUsd, poolModel, blendedRatePerMTok, ASSUMED_INPUT_SHARE } from "@/lib/llm-usage";

/**
 * GET /api/dashboard/llm-usage — "Consommation API" panel.
 *
 * Session-protected, DB-only (one query against `daily_llm_budget`), so it never blocks
 * on the Anthropic API — which matters precisely when the panel is most useful: the key
 * being rate-limited or spend-capped is one of the things an operator comes here to see.
 *
 * Costs are ESTIMATES. `daily_llm_budget` stores one combined token count per (day, pool),
 * so the input/output split is assumed per pool — see src/lib/llm-usage.ts.
 */
export const dynamic = "force-dynamic";

const POOLS: LlmBudgetPool[] = ["assistant", "batch"];
const WINDOW_DAYS = 7;

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const window = await getLlmUsageWindow(WINDOW_DAYS);
    const today = window[window.length - 1];

    const pools = POOLS.map((pool) => {
      const tokens = today[pool];
      const budget = poolBudget(pool);
      return {
        pool,
        model: poolModel(pool),
        tokens,
        budget,
        // Clamped: the gate runs BEFORE each call, so the request that crosses the cap
        // still completes and the counter can land slightly above 100%.
        pctOfBudget: budget > 0 ? Math.min(100, Math.round((tokens / budget) * 100)) : 0,
        costUsd: estimateCostUsd(pool, tokens),
        blendedRatePerMTok: blendedRatePerMTok(pool),
        assumedInputShare: ASSUMED_INPUT_SHARE[pool],
      };
    });

    const days = window.map((d) => ({
      day: d.day,
      assistant: d.assistant,
      batch: d.batch,
      costUsd: estimateCostUsd("assistant", d.assistant) + estimateCostUsd("batch", d.batch),
    }));

    return NextResponse.json(
      {
        pools,
        days,
        windowCostUsd: days.reduce((sum, d) => sum + d.costUsd, 0),
        todayCostUsd: pools.reduce((sum, p) => sum + p.costUsd, 0),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[API] GET /api/dashboard/llm-usage failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
