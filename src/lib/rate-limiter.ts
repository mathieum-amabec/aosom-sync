/**
 * Simple in-memory sliding window rate limiter.
 * Resets on serverless cold starts (acceptable for 2-user app).
 */

const windows = new Map<string, number[]>();

export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  const timestamps = windows.get(key) || [];

  // Remove expired timestamps
  const valid = timestamps.filter(t => now - t < windowMs);

  if (valid.length >= maxRequests) {
    const oldest = valid[0];
    const retryAfterMs = windowMs - (now - oldest);
    windows.set(key, valid);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  valid.push(now);
  windows.set(key, valid);
  return { allowed: true, remaining: maxRequests - valid.length, retryAfterMs: 0 };
}
