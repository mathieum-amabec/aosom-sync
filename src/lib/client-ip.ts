/**
 * Client IP for per-visitor limits on public routes: `x-real-ip` (set by Vercel), else the LAST
 * x-forwarded-for hop — the first hop is attacker-supplied (same rule as /api/assistant). IPv6 is
 * bucketed by /64, the block one household gets.
 */
export function clientIp(request: Request): string {
  let ip = request.headers.get("x-real-ip")?.trim() || "";
  if (!ip) {
    const hops = (request.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
    ip = hops[hops.length - 1] || "unknown";
  }
  if (ip.includes(":")) ip = ip.split(":").slice(0, 4).join(":") + "::/64";
  return ip;
}
