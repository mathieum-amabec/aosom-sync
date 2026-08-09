import { describe, it, expect } from "vitest";
import {
  startOfUtcDayEpoch, epochDaysAgo, estimatedRevenue, tokenExpiryStatus, tokenNeedsAttention,
  llmPoolStatus,
} from "@/lib/dashboard-metrics";

describe("date windows", () => {
  it("startOfUtcDayEpoch strips the time-of-day to UTC midnight", () => {
    const now = new Date("2026-06-07T15:30:45Z");
    expect(startOfUtcDayEpoch(now)).toBe(Math.floor(Date.parse("2026-06-07T00:00:00Z") / 1000));
  });
  it("epochDaysAgo subtracts whole days in seconds", () => {
    const now = new Date("2026-06-07T15:30:00Z");
    expect(epochDaysAgo(now, 7)).toBe(Math.floor(Date.parse("2026-06-07T15:30:00Z") / 1000) - 7 * 86400);
  });
});

describe("estimatedRevenue", () => {
  it("is ROAS × spend, rounded to cents", () => {
    expect(estimatedRevenue({ roas: 3, spend: 100 })).toBe(300);
    expect(estimatedRevenue({ roas: 2.5, spend: 40 })).toBe(100);
    expect(estimatedRevenue({ roas: 0, spend: 100 })).toBe(0);
  });
  it("is null when there are no metrics", () => {
    expect(estimatedRevenue(null)).toBeNull();
    expect(estimatedRevenue(undefined)).toBeNull();
  });
});

describe("tokenExpiryStatus", () => {
  const now = new Date("2026-06-07T12:00:00Z");
  const E = Math.floor(now.getTime() / 1000);

  it("classifies a never-expiring (system-user) token", () => {
    expect(tokenExpiryStatus({ isValid: true, expiresAt: 0 }, now)).toEqual({ state: "never", daysLeft: null });
    expect(tokenExpiryStatus({ isValid: true, expiresAt: null }, now)).toEqual({ state: "never", daysLeft: null });
  });
  it("classifies a healthy token (> 7 days out)", () => {
    expect(tokenExpiryStatus({ isValid: true, expiresAt: E + 30 * 86400 }, now)).toEqual({ state: "ok", daysLeft: 30 });
  });
  it("flags expiring_soon within 7 days (inclusive)", () => {
    expect(tokenExpiryStatus({ isValid: true, expiresAt: E + 3 * 86400 }, now)).toEqual({ state: "expiring_soon", daysLeft: 3 });
    expect(tokenExpiryStatus({ isValid: true, expiresAt: E + 7 * 86400 }, now)).toEqual({ state: "expiring_soon", daysLeft: 7 });
  });
  it("flags a past-expiry token as expired", () => {
    expect(tokenExpiryStatus({ isValid: true, expiresAt: E - 10 }, now)).toEqual({ state: "expired", daysLeft: 0 });
  });
  it("treats an invalid token as expired regardless of date", () => {
    expect(tokenExpiryStatus({ isValid: false, expiresAt: E + 99999 }, now)).toEqual({ state: "expired", daysLeft: null });
  });
});

describe("tokenNeedsAttention", () => {
  it("raises for expired/expiring_soon, not for ok/never", () => {
    expect(tokenNeedsAttention({ state: "expired", daysLeft: null })).toBe(true);
    expect(tokenNeedsAttention({ state: "expiring_soon", daysLeft: 3 })).toBe(true);
    expect(tokenNeedsAttention({ state: "ok", daysLeft: 30 })).toBe(false);
    expect(tokenNeedsAttention({ state: "never", daysLeft: null })).toBe(false);
  });
});

describe("llmPoolStatus", () => {
  const B = 500_000; // the assistant pool's default daily budget

  it("is ok below the 80% warn threshold", () => {
    expect(llmPoolStatus("assistant", 0, B)).toEqual({ pool: "assistant", state: "ok", used: 0, budget: B, pct: 0 });
    expect(llmPoolStatus("assistant", 399_999, B).state).toBe("ok");
  });

  it("warns from exactly 80% (inclusive) up to the cap", () => {
    expect(llmPoolStatus("assistant", 400_000, B)).toEqual({ pool: "assistant", state: "warning", used: 400_000, budget: B, pct: 80 });
    expect(llmPoolStatus("assistant", 499_999, B).state).toBe("warning");
  });

  // The boundary that matters: assertLlmBudget throws at used >= budget, so the panel must
  // never show "warning" for a pool that is already refusing calls.
  it("is exhausted at exactly the budget, matching assertLlmBudget's >= comparison", () => {
    expect(llmPoolStatus("assistant", B, B)).toEqual({ pool: "assistant", state: "exhausted", used: B, budget: B, pct: 100 });
    expect(llmPoolStatus("assistant", B + 1_935, B).state).toBe("exhausted");
  });

  it("reports pct to one decimal", () => {
    expect(llmPoolStatus("batch", 1_000_000, 1_300_000).pct).toBe(76.9);
  });

  it("carries the pool name through so the UI can label the row", () => {
    expect(llmPoolStatus("batch", 0, B).pool).toBe("batch");
  });

  it("treats a non-positive or non-finite budget as exhausted, never ok", () => {
    expect(llmPoolStatus("assistant", 10, 0)).toEqual({ pool: "assistant", state: "exhausted", used: 10, budget: 0, pct: 100 });
    expect(llmPoolStatus("assistant", 10, -5).state).toBe("exhausted");
    expect(llmPoolStatus("assistant", 10, Number.NaN).state).toBe("exhausted");
  });

  it("floors a negative or non-finite used at 0 rather than reporting a negative pct", () => {
    expect(llmPoolStatus("assistant", -100, B)).toEqual({ pool: "assistant", state: "ok", used: 0, budget: B, pct: 0 });
    expect(llmPoolStatus("assistant", Number.NaN, B).used).toBe(0);
  });
});

