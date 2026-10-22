import { verifyCronSecret } from "@/lib/cron-auth";
import { RELANCE_PAIEMENT_RELAY, loadEngineStateForRelays, loadRelayKeysOwnedByEngine, mergeEngineIntoRelance } from "@/lib/email/flows";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { acquireLease, getSetting, releaseLease, setSetting } from "@/lib/database";
import {
  CHECKOUT_STARTED_METRIC, ENABLED_KEY, PLACED_ORDER_METRIC, RELANCE_MAX_AGE_H, STATE_KEY, TEMPLATES_KEY,
  buildTemplateHtml, emptyState, metricId, parseCheckoutEvent, pruneState, recentEvents, relanceSubject, renderItemsHtml,
  selectCandidates, type CheckoutEvent, type RelanceState,
} from "@/lib/relance-paiement";
import {
  RELAY_LEASE_KEY, RELAY_LEASE_TTL_S, campaignStatus, cleanupLists, createList, flowsSendingAgain, kv, sendCampaign,
  shouldRetry, stillInFlight, waitForLists,
} from "@/lib/klaviyo-campaigns";

/**
 * GET /api/cron/relance-paiement — every 15 min. Emails people who started a Shopify checkout
 * and did not pay, through a Klaviyo CAMPAIGN (the account's flows never send — see
 * src/lib/relance-paiement.ts).
 *
 * Never double-sends: a lease shared with flow-relay keeps two invocations apart, and the state is
 * saved right after each send job (not at the end), before anything that could time out.
 * `?dryRun=1` lists who would get a reminder and sends nothing. Kill switch: settings
 * `relance_paiement_enabled` = "0".
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ABANDONED_CHECKOUT_FLOW = "Xw6R8f";

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  if (!dryRun && (await getSetting(ENABLED_KEY)) === "0") {
    return NextResponse.json({ success: true, skipped: "disabled" });
  }
  const lease = dryRun ? "dry" : await acquireLease(RELAY_LEASE_KEY, RELAY_LEASE_TTL_S);
  if (!lease) return NextResponse.json({ success: true, skipped: "another-relay-running" });
  try {
    return await trackCron("relance-paiement", () => run(dryRun));
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  } finally {
    if (!dryRun) await releaseLease(RELAY_LEASE_KEY, lease).catch(() => {});
  }
}

async function loadState(now: Date): Promise<RelanceState> {
  let s: RelanceState = emptyState();
  try { s = { ...emptyState(), ...JSON.parse((await getSetting(STATE_KEY)) ?? "{}") }; } catch { /* corrupt → start fresh */ }
  return pruneState(s, now);
}

async function run(dryRun: boolean) {
  const now = new Date();
  // Our own email engine (src/lib/email/flows.ts) took this reminder over: it sends it now.
  if ((await loadRelayKeysOwnedByEngine(getSetting)).has(RELANCE_PAIEMENT_RELAY)) {
    return NextResponse.json({ success: true, skipped: "taken-over-by-email-engine" });
  }
  // If Klaviyo's own Abandoned Checkout flow delivers again, stop: the customer would get both.
  const sendingAgain = await flowsSendingAgain(now);
  if (sendingAgain.has(ABANDONED_CHECKOUT_FLOW) || sendingAgain.has("*")) {
    return NextResponse.json({ success: true, skipped: "klaviyo-flow-sending-again" });
  }
  // our own email engine's reminders count as done here too (src/lib/email/flows.ts): never the same email twice
  let state = mergeEngineIntoRelance(await loadState(now), await loadEngineStateForRelays(getSetting));

  // Campaigns of earlier runs: Klaviyo's "No Recipients" cancellation → forget them so they retry.
  if (!dryRun && state.pending.length) {
    const keep: RelanceState["pending"] = [];
    for (const p of state.pending) {
      const status = await campaignStatus(p.campaignId).catch(() => "unknown");
      if (shouldRetry(status)) {
        for (const id of p.eventIds) { delete state.events[id]; delete state.sent[id]; }
        for (const id of p.profileIds) delete state.profiles[id];
      } else if (stillInFlight(status) || status === "unknown") keep.push(p);
    }
    state.pending = keep;
    await setSetting(STATE_KEY, JSON.stringify(state));
  }

  const since = new Date(now.getTime() - (RELANCE_MAX_AGE_H + 1) * 3600e3).toISOString().slice(0, 19);
  const [checkoutMetric, orderMetric] = await Promise.all([metricId(CHECKOUT_STARTED_METRIC), metricId(PLACED_ORDER_METRIC)]);
  const [checkouts, orders] = await Promise.all([recentEvents(checkoutMetric, since), recentEvents(orderMetric, since)]);
  const events = checkouts.events
    .map((e) => parseCheckoutEvent(e, checkouts.emails.get(e.relationships?.profile?.data?.id ?? "") ?? null))
    .filter((e): e is CheckoutEvent => e !== null);
  const orderTimes = new Map<string, string[]>();
  for (const o of orders.events) {
    const pid = o.relationships?.profile?.data?.id;
    if (pid) orderTimes.set(pid, [...(orderTimes.get(pid) ?? []), o.attributes.datetime]);
  }
  // an order up to 5 min before the checkout event still counts (Shopify timestamps differ slightly)
  const orderedAfter = (pid: string, iso: string) => (orderTimes.get(pid) ?? []).some((t) => Date.parse(t) >= Date.parse(iso) - 5 * 60e3);
  const { send, skipped } = selectCandidates(events, state, orderedAfter, now);

  if (dryRun) {
    return NextResponse.json({ success: true, dryRun: true, checkouts: events.length,
      wouldSend: send.map((e) => ({ at: e.at, locale: e.locale, value: e.value, items: e.items.map((i) => i.title), email: e.email?.replace(/^(.).*@/, "$1***@") })),
      skipped: skipped.reduce<Record<string, number>>((m, s) => ({ ...m, [s.reason]: (m[s.reason] ?? 0) + 1 }), {}) });
  }
  for (const s of skipped) if (s.final && s.reason !== "done") state.events[s.eventId] = now.toISOString();
  await setSetting(STATE_KEY, JSON.stringify(state));

  const results: Array<{ locale: string; sent: number; campaignId?: string; error?: string }> = [];
  if (send.length) {
    let templates: Record<string, string> = {};
    try { templates = JSON.parse((await getSetting(TEMPLATES_KEY)) ?? "{}"); } catch { /* recreate */ }
    const label = now.toISOString().slice(0, 16).replace("T", " ");
    const batches: Array<{ locale: "fr" | "en"; events: CheckoutEvent[]; listId: string }> = [];
    for (const locale of ["fr", "en"] as const) {
      const batch = send.filter((e) => e.locale === locale);
      if (!batch.length) continue;
      try {
        if (!templates[locale]) {
          const t = await kv<{ data: { id: string } }>("POST", "/templates/", { data: { type: "template", attributes: { name: `Relance paiement auto (${locale}) v1`, editor_type: "CODE", html: buildTemplateHtml(locale) } } });
          templates[locale] = t.data.id;
          await setSetting(TEMPLATES_KEY, JSON.stringify(templates));
        }
        for (const e of batch) {
          await kv("PATCH", `/profiles/${e.profileId}/`, { data: { type: "profile", id: e.profileId, attributes: { properties: {
            relance_url: e.recoverUrl, relance_items_html: renderItemsHtml(e), relance_checkout_at: e.at,
          } } } });
        }
        batches.push({ locale, events: batch, listId: await createList(`Relance paiement auto ${label} ${locale}`, batch.map((e) => e.profileId)) });
      } catch (err) {
        results.push({ locale, sent: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (batches.length) await waitForLists(batches.map((b) => ({ id: b.listId, size: b.events.length })));
    for (const b of batches) {
      try {
        const { subject, preview } = relanceSubject(b.locale);
        const { campaignId } = await sendCampaign({ name: `Relance paiement auto ${label} ${b.locale}`, listId: b.listId, templateId: templates[b.locale], subject, preview, label: "relance" });
        // Saved at once: a timeout after this point must not make the next run send it again.
        state = { ...state, pending: [...state.pending, { campaignId, eventIds: b.events.map((e) => e.eventId), profileIds: b.events.map((e) => e.profileId), at: now.toISOString() }] };
        for (const e of b.events) { state.events[e.eventId] = now.toISOString(); state.sent[e.eventId] = now.toISOString(); state.profiles[e.profileId] = now.toISOString(); }
        await setSetting(STATE_KEY, JSON.stringify(state));
        results.push({ locale: b.locale, sent: b.events.length, campaignId });
      } catch (err) {
        results.push({ locale: b.locale, sent: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  const cleaned = await cleanupLists(72, now).catch(() => 0);
  const sent = results.reduce((n, r) => n + r.sent, 0);
  return NextResponse.json({ success: results.every((r) => !r.error), checkouts: events.length, candidates: send.length, sent, results, cleanedLists: cleaned });
}
