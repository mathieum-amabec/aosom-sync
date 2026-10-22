import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { acquireLease, getEmailSendStatus, getSetting, listSuppressionsNotInKlaviyo, markSuppressionInKlaviyo, releaseLease, setSetting } from "@/lib/database";
import { RELAY_LEASE_KEY, RELAY_LEASE_TTL_S, flowsSendingAgain } from "@/lib/klaviyo-campaigns";
import { STATE_KEY as RELANCE_STATE_KEY } from "@/lib/relance-paiement";
import { triggerEvents, type RelayState } from "@/lib/flow-relay";
import { configProblems, defaultEngineDeps, loadEngineConfig, sendEmail } from "@/lib/email/engine";
import { klaviyoConsent, suppressInKlaviyo } from "@/lib/email/consent";
import { GROUPS, STATE_KEY, TAKEOVER_KEY, TEST_STATE_KEY, parseEngineState, parseTakeover, relayView, runEmailFlows, type RelanceLike } from "@/lib/email/flows";
import { emailKey } from "@/lib/email/unsubscribe";

/**
 * GET /api/cron/email-flows — every 15 min. Sends the flow emails through our own engine (Resend),
 * for the groups taken over from the Klaviyo relays (src/lib/email/flows.ts).
 *
 * Does nothing while `email_engine_mode` is "off" (default) or a piece of configuration is missing.
 * Shares the relays' lease, so it never runs at the same time as them. `?dryRun=1` counts, for every
 * group as if all were taken over, how many emails are due now; it sends and saves nothing.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BUDGET_MS = 200_000;
const SENT_STATUSES = new Set(["sent", "delivered", "opened", "clicked"]);

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  const cfg = await loadEngineConfig(getSetting);
  if (!dryRun) {
    // even when off: an unsubscribe link from an earlier email can still be clicked
    const synced = await syncSuppressionsToKlaviyo().catch(() => 0);
    if (cfg.mode === "off") return NextResponse.json({ success: true, skipped: "off", suppressionsSyncedToKlaviyo: synced });
    const problems = configProblems(cfg);
    if (problems.length) return NextResponse.json({ success: false, skipped: "not-configured", problems, suppressionsSyncedToKlaviyo: synced });
  }
  const lease = dryRun ? "dry" : await acquireLease(RELAY_LEASE_KEY, RELAY_LEASE_TTL_S);
  if (!lease) return NextResponse.json({ success: true, skipped: "another-relay-running" });
  try {
    return await trackCron("email-flows", async () => NextResponse.json({ success: true, mode: cfg.mode, dryRun, ...(await run(dryRun, cfg)) }));
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  } finally {
    if (!dryRun) await releaseLease(RELAY_LEASE_KEY, lease).catch(() => {});
  }
}

async function readJson<T>(key: string): Promise<T | null> {
  try { return JSON.parse((await getSetting(key)) ?? "null") as T | null; } catch { return null; }
}

async function run(dryRun: boolean, cfg: Awaited<ReturnType<typeof loadEngineConfig>>) {
  const started = Date.now();
  const now = new Date();
  const takeover = dryRun ? Object.fromEntries(GROUPS.map((g) => [g, now.toISOString()])) : parseTakeover(await getSetting(TAKEOVER_KEY));
  const relay = await readJson<RelayState>("flow_relay_state");
  const relance = await readJson<RelanceLike>(RELANCE_STATE_KEY);
  const sendingAgain = await flowsSendingAgain(now);
  const deps = dryRun ? null : await defaultEngineDeps(cfg.apiKey);
  // test runs keep their own bookkeeping: they must never mark real customers' emails as done
  const stateKey = cfg.mode === "test" && !dryRun ? TEST_STATE_KEY : STATE_KEY;

  return runEmailFlows({
    now,
    mode: dryRun ? "live" : cfg.mode,
    takeover,
    loadState: async () => parseEngineState(await getSetting(stateKey)),
    saveState: (s) => setSetting(stateKey, JSON.stringify(s)),
    events: triggerEvents,
    relay: relayView(relay, relance),
    relance1Sent: async (eventId) => !!relance?.sent?.[eventId] || SENT_STATUSES.has((await getEmailSendStatus(`relance-1:${eventId}`)) ?? ""),
    flowSendingAgain: (flowId) => sendingAgain.has(flowId) || sendingAgain.has("*"),
    consentOf: klaviyoConsent,
    recipientAllowed: (email) => cfg.mode !== "test" || cfg.testRecipients.has(emailKey(email)),
    send: (msg) => sendEmail(msg, cfg, deps!),
    timeLeft: () => Date.now() - started < BUDGET_MS,
  }, { dryRun });
}

/**
 * Unsubscribes, hard bounces and complaints recorded here but not yet in Klaviyo (its call failed,
 * or came from the Resend webhook): push them now, so the relays stop mailing those people too.
 */
async function syncSuppressionsToKlaviyo(): Promise<number> {
  if (!process.env.KLAVIYO_API_KEY) return 0;
  let n = 0;
  for (const email of await listSuppressionsNotInKlaviyo(50)) {
    try {
      await suppressInKlaviyo(email);
      await markSuppressionInKlaviyo(email);
      n++;
    } catch (err) {
      console.warn(`[email-flows] Klaviyo suppression failed, retried next run: ${err}`);
      break;
    }
  }
  return n;
}
