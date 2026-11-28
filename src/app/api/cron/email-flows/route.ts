import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import {
  acquireLease, countPendingOutbox, dueOutboxEmails, finishOutboxEmail, getEmailConsent, getEmailSendStatus, getSetting,
  isEmailSuppressed, lastEmailSentTo, listConsentsNotInShopify, listSuppressionsNotInKlaviyo, listSuppressionsNotInShopify, markConsentInShopify,
  markSuppressionInKlaviyo, markSuppressionInShopify, releaseLease, setSetting, wheelSpinsForEngine,
} from "@/lib/database";
import { RELAY_LEASE_KEY, RELAY_LEASE_TTL_S, flowsSendingAgain } from "@/lib/klaviyo-campaigns";
import { ENABLED_KEY as RELANCE_ENABLED_KEY, STATE_KEY as RELANCE_STATE_KEY } from "@/lib/relance-paiement";
import { RELANCE2_ENABLED_KEY, genericCheckout2Yields, relance2Enabled } from "@/lib/relance-code";
import { WHEEL_WON, triggerEvents, type RelayState } from "@/lib/flow-relay";
import { WHEEL_PRIZES } from "@/lib/welcome-wheel";
import { configProblems, defaultEngineDeps, loadEngineConfig, sendEmail } from "@/lib/email/engine";
import { klaviyoConsent, suppressInKlaviyo, type KlaviyoConsent } from "@/lib/email/consent";
import { routeFor } from "@/lib/email/dispatch";
import { GROUPS, STATE_KEY, TAKEOVER_KEY, TEST_STATE_KEY, effectiveTakeover, parseEngineState, parseTakeover, relayView, runEmailFlows, type RelanceLike } from "@/lib/email/flows";
import { drainOutbox } from "@/lib/email/outbox";
import { CONSENT_TO_SHOPIFY_KEY, ShopifyConsentRefused, setShopifyEmailConsent } from "@/lib/email/shopify-consent";
import { emailKey } from "@/lib/email/unsubscribe";
import { mergeWheelEvents } from "@/lib/email/wheel-source";

/**
 * GET /api/cron/email-flows — every 15 min. Sends the flow emails through our own engine (Resend): every group when
 * settings `email_provider` = "resend" (only the test addresses when "test"), else the groups ticked in the legacy
 * hand-over (src/lib/email/flows.ts). Then sends what waits in `email_outbox` (Resend's daily cap, outbox.ts).
 *
 * Does nothing while the engine is off or a piece of configuration is missing. Shares the relays' lease, so it never
 * runs at the same time as them. `?dryRun=1` counts, for every group as if all were taken over, how many emails are
 * due now, and shows the provider, the configuration problems and the queue; it sends and saves nothing.
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
    // Shopify Email campaigns read the Shopify customer's consent: our unsubscribes go there too (not in "klaviyo")
    const shopify = cfg.provider !== "klaviyo" ? await syncConsentToShopify().catch((err) => ({ error: String(err) })) : null;
    if (cfg.mode === "off") return NextResponse.json({ success: true, skipped: "off", suppressionsSyncedToKlaviyo: synced, shopify });
    const problems = configProblems(cfg);
    if (problems.length) return NextResponse.json({ success: false, skipped: "not-configured", problems, suppressionsSyncedToKlaviyo: synced, shopify });
  }
  const lease = dryRun ? "dry" : await acquireLease(RELAY_LEASE_KEY, RELAY_LEASE_TTL_S);
  if (!lease) return NextResponse.json({ success: true, skipped: "another-relay-running" });
  try {
    return await trackCron("email-flows", async () => NextResponse.json({ success: true, mode: cfg.mode, provider: cfg.provider, dryRun, ...(await run(dryRun, cfg)) }));
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  } finally {
    if (!dryRun) await releaseLease(RELAY_LEASE_KEY, lease).catch(() => {});
  }
}

async function readJson<T>(key: string): Promise<T | null> {
  try { return JSON.parse((await getSetting(key)) ?? "null") as T | null; } catch { return null; }
}

/** Consent of a trigger's person: Klaviyo for a Klaviyo profile, our own table for a Turso wheel spin (`email:`). */
async function consentOf(pid: string): Promise<KlaviyoConsent> {
  if (!pid.startsWith("email:")) return klaviyoConsent(pid);
  const email = pid.slice(6);
  const [row, suppressed] = await Promise.all([getEmailConsent(email), isEmailSuppressed(email)]);
  return { consent: row?.status === "unsubscribed" ? "UNSUBSCRIBED" : row ? "SUBSCRIBED" : "NEVER_SUBSCRIBED", suppressed };
}

async function run(dryRun: boolean, cfg: Awaited<ReturnType<typeof loadEngineConfig>>) {
  const started = Date.now();
  const now = new Date();
  const takeover = dryRun ? Object.fromEntries(GROUPS.map((g) => [g, now.toISOString()])) : effectiveTakeover(cfg, parseTakeover(await getSetting(TAKEOVER_KEY)));
  const relay = await readJson<RelayState>("flow_relay_state");
  const relance = await readJson<RelanceLike & { events2?: Record<string, string> }>(RELANCE_STATE_KEY);
  const [r2Flag, relanceFlag] = await Promise.all([getSetting(RELANCE2_ENABLED_KEY), getSetting(RELANCE_ENABLED_KEY)]);
  const r2Active = relance2Enabled(r2Flag) && relanceFlag !== "0";
  const sendingAgain = await flowsSendingAgain(now);
  const deps = dryRun ? null : await defaultEngineDeps(cfg.apiKey);
  // test runs keep their own bookkeeping: they must never mark real customers' emails as done
  const stateKey = cfg.mode === "test" && !dryRun ? TEST_STATE_KEY : STATE_KEY;

  const flows = await runEmailFlows({
    now,
    mode: dryRun ? "live" : cfg.mode,
    takeover,
    loadState: async () => parseEngineState(await getSetting(stateKey)),
    saveState: (s) => setSetting(stateKey, JSON.stringify(s)),
    events: async (metricId, since) => {
      const klaviyo = await triggerEvents(metricId, since);
      if (metricId !== WHEEL_WON) return klaviyo;
      // spins recorded while email_provider = "resend" have no Klaviyo event: they live in Turso only
      const rows = await wheelSpinsForEngine(Math.floor(Date.parse(`${since}Z`) / 1000) || 0);
      return mergeWheelEvents(klaviyo, rows, WHEEL_PRIZES);
    },
    relay: relayView(relay, relance),
    relance1Sent: async (eventId) => !!relance?.sent?.[eventId] || SENT_STATUSES.has((await getEmailSendStatus(`relance-1:${eventId}`)) ?? ""),
    flowSendingAgain: (flowId) => sendingAgain.has(flowId) || sendingAgain.has("*"),
    consentOf,
    recipientAllowed: (email) => cfg.mode !== "test" || cfg.testRecipients.has(emailKey(email)),
    // the 15 $ code reminder (relance-code.ts) owns some checkouts: the generic reminder #2 yields to it, never both
    checkout2Yields: (ev) => genericCheckout2Yields(ev.id, ev.props, relance ?? {}, r2Active),
    send: (msg) => sendEmail(msg, cfg, deps!),
    // follow-up reminders keep a few hours from any other email to the same person (two chains crossing)
    lastEmailAt: async (email) => { const t = await lastEmailSentTo(emailKey(email)); return t == null ? null : t * 1000; },
    timeLeft: () => Date.now() - started < BUDGET_MS,
  }, { dryRun });

  if (dryRun) return { ...flows, route: routeFor(cfg), problems: configProblems(cfg), outboxPending: await countPendingOutbox().catch(() => null) };
  const outbox = await drainOutbox({
    now: new Date(),
    due: dueOutboxEmails,
    finish: finishOutboxEmail,
    send: (msg) => sendEmail(msg, cfg, deps!),
    timeLeft: () => Date.now() - started < BUDGET_MS + 60_000,
  });
  return { ...flows, outbox };
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
      // Klaviyo refuses this one address (4xx other than 429): set it aside so it never blocks the others
      const status = Number(/→ (\d{3})/.exec(String(err))?.[1] ?? 0);
      if (status >= 400 && status < 500 && status !== 429) {
        console.error(`[email-flows] Klaviyo refused suppression of one address (${status}), not retried: ${err}`);
        await markSuppressionInKlaviyo(email, 2);
        continue;
      }
      console.warn(`[email-flows] Klaviyo suppression failed, retried next run: ${err}`);
      break;
    }
  }
  return n;
}

/**
 * Shopify side of consent: unsubscribes from our emails → the Shopify customer (always, once the provider left
 * "klaviyo"), and the wheel's ticked boxes → a subscribed Shopify customer (only with email_consent_to_shopify = "1").
 */
async function syncConsentToShopify(): Promise<{ unsubscribed: number; subscribed: number }> {
  const out = { unsubscribed: 0, subscribed: 0 };
  const push = async (email: string, state: "SUBSCRIBED" | "UNSUBSCRIBED", locale: string | null, mark: (e: string, s?: 1 | 2) => Promise<void>) => {
    try {
      await setShopifyEmailConsent(email, state, { locale });
      await mark(email, 1);
      return true;
    } catch (err) {
      if (err instanceof ShopifyConsentRefused) { await mark(email, 2); console.error(`[email-flows] Shopify refused consent ${state} for one address: ${err.message}`); return false; }
      throw err; // transient: retried next run
    }
  };
  for (const email of await listSuppressionsNotInShopify(25)) if (await push(email, "UNSUBSCRIBED", null, markSuppressionInShopify)) out.unsubscribed++;
  if ((await getSetting(CONSENT_TO_SHOPIFY_KEY)) === "1") {
    for (const c of await listConsentsNotInShopify(25)) {
      if (await isEmailSuppressed(c.email)) { await markConsentInShopify(c.email, 2); continue; }
      if (await push(c.email, "SUBSCRIBED", c.locale, markConsentInShopify)) out.subscribed++;
    }
  }
  return out;
}
