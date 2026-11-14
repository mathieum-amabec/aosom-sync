import { describe, it, expect, vi } from "vitest";

// The cost estimator reads the live model config, so pin it: these assertions are about the
// arithmetic and the pool→model routing, not about which model happens to be current.
vi.mock("@/lib/config", () => ({
  env: { anthropicApiKey: "test-key" },
  CLAUDE: {
    MODEL: "claude-sonnet-4-6",
    MODEL_BATCH: "claude-haiku-4-5",
  },
  // assistant + video QC moved to Gemini 3.5 Flash-Lite on 2026-10-02.
  GEMINI: {
    MODEL_ASSISTANT: "gemini-3.5-flash-lite",
    MODEL_VIDEO_QC: "gemini-3.5-flash-lite",
  },
}));

const {
  estimateCostUsd,
  blendedRatePerMTok,
  poolModel,
  pricingKey,
  utcDayKeys,
  MODEL_PRICING,
  ASSUMED_INPUT_SHARE,
} = await import("@/lib/llm-usage");

describe("pool → model routing", () => {
  it("prices the assistant pool with the assistant model and batch with the batch model", () => {
    expect(poolModel("assistant")).toBe("gemini-3.5-flash-lite");
    expect(poolModel("batch")).toBe("claude-haiku-4-5");
  });

  it("prices the video pool with the video-QC model, not the batch model", () => {
    expect(poolModel("video")).toBe("gemini-3.5-flash-lite");
  });
});

describe("dated snapshot ids", () => {
  it("strips a -YYYYMMDD suffix so a dated id prices off its family", () => {
    expect(pricingKey("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(pricingKey("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("prices the Gemini assistant model off its own row, never the Sonnet fallback", () => {
    // An unknown model falls back to Sonnet rates (never "free"); the Gemini row must exist
    // or the assistant pool would read ~8× too expensive on the usage dashboard.
    const flashLite = MODEL_PRICING["gemini-3.5-flash-lite"];
    expect(flashLite).toEqual({ inputPerMTok: 0.3, outputPerMTok: 2.5 });
    expect(blendedRatePerMTok("assistant")).toBeCloseTo(
      flashLite.inputPerMTok * 0.9 + flashLite.outputPerMTok * 0.1,
      10,
    );
  });
});

describe("blended rate", () => {
  it("weights each model's input and output price by the pool's assumed split", () => {
    // assistant on Gemini 3.5 Flash-Lite: 90% in → 0.9*0.3 + 0.1*2.5 = 0.52
    expect(blendedRatePerMTok("assistant")).toBeCloseTo(0.52, 10);
    // batch: 40% in → 0.4*1 + 0.6*5 = 3.40
    expect(blendedRatePerMTok("batch")).toBeCloseTo(3.4, 10);
  });

  it("keeps Haiku at exactly one third of Sonnet on both input and output", () => {
    const sonnet = MODEL_PRICING["claude-sonnet-4-6"];
    const haiku = MODEL_PRICING["claude-haiku-4-5"];
    expect(haiku.inputPerMTok * 3).toBe(sonnet.inputPerMTok);
    expect(haiku.outputPerMTok * 3).toBe(sonnet.outputPerMTok);
  });

  it("uses a documented input share for every pool (no silent 50/50 default)", () => {
    expect(ASSUMED_INPUT_SHARE.assistant).toBeGreaterThan(0.5); // input-heavy
    expect(ASSUMED_INPUT_SHARE.batch).toBeLessThan(0.5); // output-heavy
    expect(ASSUMED_INPUT_SHARE.video).toBeGreaterThan(0.5); // vision calls: heavily input-heavy
  });

  it("video pool: measured 94% input share, now on Gemini 3.5 Flash-Lite", () => {
    // 0.94*0.3 + 0.06*2.5 = 0.432 (was 3.72 on Sonnet 4.6).
    expect(blendedRatePerMTok("video")).toBeCloseTo(0.432, 10);
  });
});

describe("estimateCostUsd", () => {
  it("scales linearly with tokens", () => {
    // 0.52/MTok on Gemini 3.5 Flash-Lite (1.40 on Haiku, 4.20 on Sonnet 4.6).
    expect(estimateCostUsd("assistant", 1_000_000)).toBeCloseTo(0.52, 10);
    expect(estimateCostUsd("assistant", 500_000)).toBeCloseTo(0.26, 10);
  });

  it("prices a full assistant pool day well under the Haiku-era cost", () => {
    // A saturated 500k-token day: $0.70 on Haiku (1.40/MTok), $0.26 on Flash-Lite (0.52/MTok).
    const haikuEraDay = (500_000 / 1e6) * 1.4;
    expect(estimateCostUsd("assistant", 500_000)).toBeCloseTo(0.26, 10);
    expect(estimateCostUsd("assistant", 500_000)).toBeLessThan(haikuEraDay / 2.5);
  });

  it("returns 0 for zero, negative, and non-finite input rather than NaN", () => {
    expect(estimateCostUsd("batch", 0)).toBe(0);
    expect(estimateCostUsd("batch", -5)).toBe(0);
    expect(estimateCostUsd("batch", Number.NaN)).toBe(0);
  });

  it("reproduces the measured 2026-09-22 demand-gen-ext run within a cent", () => {
    // Real counter delta that day: 697,528 tokens for 19 SKU attempts (8 delivered, 9 QC
    // rejects, 2 technical fails at ~0 cost). Anchors the video pool's estimate to an
    // actual measured day, the same way the assistant/batch test above does.
    // Re-priced on Gemini: $2.59 on Sonnet → ~$0.30.
    const cost = estimateCostUsd("video", 697_528);
    expect(cost).toBeCloseTo(697_528 / 1e6 * 0.432, 6);
    expect(cost).toBeGreaterThan(0.29);
    expect(cost).toBeLessThan(0.31);
  });

  it("reproduces the measured 2026-08-18 day within a cent", () => {
    // Real counters: assistant 500,458 + batch 432,112. Re-priced with the assistant on
    // Gemini Flash-Lite: $3.57 (Sonnet) → $2.17 (Haiku) → $1.73 — the batch half is unchanged.
    const total = estimateCostUsd("assistant", 500_458) + estimateCostUsd("batch", 432_112);
    expect(total).toBeCloseTo(500_458 / 1e6 * 0.52 + 432_112 / 1e6 * 3.4, 6);
    expect(total).toBeGreaterThan(1.7);
    expect(total).toBeLessThan(1.76);
  });
});

describe("utcDayKeys", () => {
  it("returns `days` UTC keys, oldest first, ending on the given day", () => {
    const keys = utcDayKeys(7, new Date("2026-08-20T00:30:00Z"));
    expect(keys).toHaveLength(7);
    expect(keys[0]).toBe("2026-08-14");
    expect(keys[6]).toBe("2026-08-20");
  });

  it("crosses a month boundary correctly", () => {
    const keys = utcDayKeys(3, new Date("2026-09-01T12:00:00Z"));
    expect(keys).toEqual(["2026-08-30", "2026-08-31", "2026-09-01"]);
  });

  it("uses the UTC day, not the local one, for a late-evening local timestamp", () => {
    // 2026-08-19 23:30 UTC is still the 19th in UTC even where local time is the 20th.
    expect(utcDayKeys(1, new Date("2026-08-19T23:30:00Z"))).toEqual(["2026-08-19"]);
  });
});
