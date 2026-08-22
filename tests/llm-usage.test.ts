import { describe, it, expect, vi } from "vitest";

// The cost estimator reads the live model config, so pin it: these assertions are about the
// arithmetic and the pool→model routing, not about which model happens to be current.
vi.mock("@/lib/config", () => ({
  env: { anthropicApiKey: "test-key" },
  CLAUDE: { MODEL: "claude-sonnet-4-6", MODEL_BATCH: "claude-haiku-4-5" },
}));

const { estimateCostUsd, blendedRatePerMTok, poolModel, utcDayKeys, MODEL_PRICING, ASSUMED_INPUT_SHARE } =
  await import("@/lib/llm-usage");

describe("pool → model routing", () => {
  it("prices the assistant pool with the assistant model and batch with the batch model", () => {
    expect(poolModel("assistant")).toBe("claude-sonnet-4-6");
    expect(poolModel("batch")).toBe("claude-haiku-4-5");
  });
});

describe("blended rate", () => {
  it("weights each model's input and output price by the pool's assumed split", () => {
    // assistant: 90% in → 0.9*3 + 0.1*15 = 4.20
    expect(blendedRatePerMTok("assistant")).toBeCloseTo(4.2, 10);
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
  });
});

describe("estimateCostUsd", () => {
  it("scales linearly with tokens", () => {
    expect(estimateCostUsd("assistant", 1_000_000)).toBeCloseTo(4.2, 10);
    expect(estimateCostUsd("assistant", 500_000)).toBeCloseTo(2.1, 10);
  });

  it("returns 0 for zero, negative, and non-finite input rather than NaN", () => {
    expect(estimateCostUsd("batch", 0)).toBe(0);
    expect(estimateCostUsd("batch", -5)).toBe(0);
    expect(estimateCostUsd("batch", Number.NaN)).toBe(0);
  });

  it("reproduces the measured 2026-08-18 day within a cent", () => {
    // Real counters: assistant 500,458 + batch 432,112.
    const total = estimateCostUsd("assistant", 500_458) + estimateCostUsd("batch", 432_112);
    expect(total).toBeCloseTo(500_458 / 1e6 * 4.2 + 432_112 / 1e6 * 3.4, 6);
    expect(total).toBeGreaterThan(3.5);
    expect(total).toBeLessThan(3.6);
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
