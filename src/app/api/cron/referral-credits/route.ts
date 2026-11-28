import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { runReferralCredits } from "@/lib/referral/credits";
import { defaultReferralDeps } from "@/lib/referral/deps";
import type { ReferralMode } from "@/lib/referral/rules";

/**
 * GET /api/cron/referral-credits — hourly: gives a referrer a 10 $ MERCI10- code when a friend's PAID first order used
 * their AMI- code (anti-fraud in src/lib/referral/rules.ts), once per order, max 5 per referrer, and withdraws an unused
 * credit when the friend was refunded. All the work runs in this process — never a fetch to our own app.
 * Mode = `settings.referral_mode` (off | dry | live, default off); `?mode=off|dry|live` overrides it for one call.
 * Protected by CRON_SECRET (Bearer).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const m = new URL(request.url).searchParams.get("mode");
  const mode: ReferralMode | undefined = m === "off" || m === "dry" || m === "live" ? m : undefined;
  try {
    const result = await trackCron(
      "referral-credits",
      () => runReferralCredits({ deps: defaultReferralDeps(), mode }),
      (r) =>
        `${r.mode}: commandes=${r.ordersSeen} déjà=${r.alreadyDecided} crédités=${r.credited} refusés=${r.rejected} ` +
        `en attente=${r.waiting} échecs=${r.failed} courriel KO=${r.notifyFailed} retirés=${r.revoked}/${r.rechecked}` +
        (r.stuckPending ? ` BLOQUÉS=${r.stuckPending}` : ""),
    );
    return NextResponse.json({ success: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/referral-credits failed:", err);
    return NextResponse.json({ success: false, error: "referral-credits failed" }, { status: 500 });
  }
}
