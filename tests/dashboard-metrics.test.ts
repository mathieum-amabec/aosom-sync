import { describe, it, expect } from "vitest";
import {
  startOfUtcDayEpoch, epochDaysAgo, estimatedRevenue, tokenExpiryStatus, tokenNeedsAttention,
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
