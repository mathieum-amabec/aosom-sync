import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { timeAgo } from "@/lib/utils";

describe("timeAgo", () => {
  const NOW = new Date("2026-04-05T12:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for 0 seconds ago', () => {
    expect(timeAgo(new Date(NOW).toISOString())).toBe("just now");
  });

  it('returns "just now" for 59 seconds ago', () => {
    expect(timeAgo(new Date(NOW - 59_000).toISOString())).toBe("just now");
  });

  it('returns "1m ago" for exactly 60 seconds ago', () => {
    expect(timeAgo(new Date(NOW - 60_000).toISOString())).toBe("1m ago");
  });

  it('returns "59m ago" for 59 minutes ago', () => {
    expect(timeAgo(new Date(NOW - 59 * 60_000).toISOString())).toBe("59m ago");
  });

  it('returns "1h ago" for exactly 60 minutes ago', () => {
    expect(timeAgo(new Date(NOW - 3_600_000).toISOString())).toBe("1h ago");
  });

  it('returns "23h ago" for 23 hours ago', () => {
    expect(timeAgo(new Date(NOW - 23 * 3_600_000).toISOString())).toBe("23h ago");
  });

  it('returns "1d ago" for exactly 24 hours ago', () => {
    expect(timeAgo(new Date(NOW - 86_400_000).toISOString())).toBe("1d ago");
  });

  it('returns "7d ago" for 7 days ago', () => {
    expect(timeAgo(new Date(NOW - 7 * 86_400_000).toISOString())).toBe("7d ago");
  });
});
