import { verifyCronSecret } from "@/lib/cron-auth";
import { RELANCE_PAIEMENT_RELAY, loadEngineStateForRelays, loadRelayKeysOwnedByEngine, mergeEngineIntoRelance, mergeEngineIntoRelay } from "@/lib/email/flows";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { acquireLease, getSetting, releaseLease, setSetting } from "@/lib/database";
import {
  CHECKOUT_STARTED_METRIC, ENABLED_KEY, PLACED_ORDER_METRIC, RELANCE_MAX_AGE_H, STATE_KEY, TEMPLATES_KEY,
  buildTemplateHtml, emptyState, metricId, parseCheckoutEvent, pruneState, recentEvents, relanceSubject, renderItemsHtml,
  selectCandidates, type CheckoutEvent, type RelanceState,
} from "@/lib/relance-paiement";
import {
  RELANCE2_ENABLED_KEY, RELANCE2_MAX_AGE_H, RELANCE2_TEMPLATES_KEY, buildRelance2TemplateHtml, createRelance2Discount,
  ensureRelance2Codes, relance2Enabled, relance2ProfileProps, relance2Subject, selectRelance2, type StoredCode,
} from "@/lib/relance-code";
import { emptyRelayState, type RelayState } from "@/lib/flow-relay";
import {
  RELAY_LEASE_KEY, RELAY_LEASE_TTL_S, campaignStatus, cleanupLists, createList, flowsSendingAgain, kv, sendCampaign,
  shouldRetry, stillInFlight, waitForLists,
} from "@/lib/klaviyo-campaigns";

/**
 * GET /api/cron/relance-paiement — every 15 min. Emails people who started a Shopify checkout
 * and did not pay, through a Klaviyo CAMPAIGN (the account's flows never send — see
 * src/lib/relance-paiement.ts):
 *   - reminder #1, ~30 min after the checkout;
 *   - reminder #2 WITH A 15 $ CODE, ~24 h after a checkout of ≥ 250 $ (src/lib/relance-code.ts),
 *     only while settings `relance2_enabled` = "1" (default OFF).
 *
 * Never double-sends: a lease shared with flow-relay keeps two invocations apart, and the state is
 * saved right after each send job (and each code creation), before anything that could time out.
 * `?dryRun=1` lists who would get a reminder and sends nothing, creates no code. Kill switch:
 * settings `relance_paiement_enabled` = "0" (stops both).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ABANDONED_CHECKOUT_FLOW = "Xw6R8f";
const FLOW_RELAY_STATE_KEY = "flow_relay_state";

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

const mask = (email: string | null) => email?.replace(/^(.).*@/, "$1***@");
const countReasons = (skipped: Array<{ reason: string }>) => skipped.reduce<Record<string, number>>((m, s) => ({ ...m, [s.reason]: (m[s.reason] ?? 0) + 1 }), {});

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
  const engine = await loadEngineStateForRelays(getSetting);
  let state = mergeEngineIntoRelance(await loadState(now), engine);
  const r2On = relance2Enabled(await getSetting(RELANCE2_ENABLED_KEY));

  // Campaigns of earlier runs: Klaviyo's "No Recipients" cancellation → forget them so they retry.
  if (!dryRun && state.pending.length) {
    const keep: RelanceState["pending"] = [];
    for (const p of state.pending) {
      const status = await campaignStatus(p.campaignId).catch(() => "unknown");
      if (shouldRetry(status)) {
        if (p.kind === "r2") {
          // the stored code stays: the retry reuses it
          for (const id of p.eventIds) { delete state.events2[id]; delete state.sent2[id]; }
          for (const id of p.profileIds) delete state.profiles2[id];
        } else {
          for (const id of p.eventIds) { delete state.events[id]; delete state.sent[id]; }
          for (const id of p.profileIds) delete state.profiles[id];
        }
      } else if (stillInFlight(status) || status === "unknown") keep.push(p);
    }
    state.pending = keep;
    await setSetting(STATE_KEY, JSON.stringify(state));
  }

  const since = new Date(now.getTime() - (Math.max(RELANCE_MAX_AGE_H, RELANCE2_MAX_AGE_H) + 1) * 3600e3).toISOString().slice(0, 19);
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

  // Reminder #2 with code: never for a checkout whose generic reminder #2 (flow-relay "checkout-2") went out.
  let relay: RelayState = emptyRelayState();
  try { relay = { ...emptyRelayState(), ...JSON.parse((await getSetting(FLOW_RELAY_STATE_KEY)) ?? "{}") }; } catch { /* none */ }
  const checkout2 = mergeEngineIntoRelay(relay, engine).done["checkout-2"] ?? {};
  const r1Profiles = new Set(send.map((e) => e.profileId));
  const r2 = selectRelance2(events, state, { now, orderedAfter, checkout2Sent: (id) => !!checkout2[id], busy: (pid) => r1Profiles.has(pid) });

  if (dryRun) {
    // never creates a code: only shows the payload it would send
    const plan = await ensureRelance2Codes(r2.send, { now, state: structuredClone(state), save: async () => {}, create: async () => { throw new Error("dry run"); } }, { dryRun: true });
    return NextResponse.json({ success: true, dryRun: true, checkouts: events.length,
      wouldSend: send.map((e) => ({ at: e.at, locale: e.locale, value: e.value, items: e.items.map((i) => i.title), email: mask(e.email) })),
      skipped: countReasons(skipped),
      relance2: { enabled: r2On,
        wouldSend: r2.send.map((e) => ({ at: e.at, locale: e.locale, subtotal: e.subtotal, email: mask(e.email), reuseCode: !!state.codes[e.eventId] })),
        skipped: countReasons(r2.skipped), discountPayload: plan.wouldCreate[0] ?? null } });
  }
  for (const s of skipped) if (s.final && s.reason !== "done") state.events[s.eventId] = now.toISOString();
  if (r2On) for (const s of r2.skipped) if (s.final && s.reason !== "done") state.events2[s.eventId] = now.toISOString();
  await setSetting(STATE_KEY, JSON.stringify(state));

  const results: Array<{ kind: "r1" | "r2"; locale: string; sent: number; campaignId?: string; error?: string }> = [];
  const label = now.toISOString().slice(0, 16).replace("T", " ");
  type Batch = { kind: "r1" | "r2"; locale: "fr" | "en"; events: CheckoutEvent[]; listId: string; templateId: string };
  const batches: Batch[] = [];

  // reminder #1 — template, profile data, list
  if (send.length) {
    let templates: Record<string, string> = {};
    try { templates = JSON.parse((await getSetting(TEMPLATES_KEY)) ?? "{}"); } catch { /* recreate */ }
    for (const locale of ["fr", "en"] as const) {
      const batch = send.filter((e) => e.locale === locale);
      if (!batch.length) continue;
      try {
        if (!templates[locale]) {
          const t = await kv<{ data: { id: string } }>("POST", "/templates/", { data: { type: "template", attributes: { name: `Relance paiement auto (${locale}) v2`, editor_type: "CODE", html: buildTemplateHtml(locale) } } });
          templates[locale] = t.data.id;
          await setSetting(TEMPLATES_KEY, JSON.stringify(templates));
        }
        for (const e of batch) {
          await kv("PATCH", `/profiles/${e.profileId}/`, { data: { type: "profile", id: e.profileId, attributes: { properties: {
            relance_url: e.recoverUrl, relance_items_html: renderItemsHtml(e), relance_checkout_at: e.at,
          } } } });
        }
        batches.push({ kind: "r1", locale, events: batch, templateId: templates[locale], listId: await createList(`Relance paiement auto ${label} ${locale}`, batch.map((e) => e.profileId)) });
      } catch (err) {
        results.push({ kind: "r1", locale, sent: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // reminder #2 with code — one Shopify code per checkout (stored before any email), template, profile data, list
  if (r2On && r2.send.length) {
    const codes = await ensureRelance2Codes(r2.send, {
      now, state, save: (s) => setSetting(STATE_KEY, JSON.stringify(s)), create: (input) => createRelance2Discount(input),
    });
    for (const e of codes.errors) results.push({ kind: "r2", locale: "-", sent: 0, error: `${e.eventId}: ${e.error}` });
    const codeOf = new Map<string, StoredCode>(codes.ready.map((r) => [r.event.eventId, r.code]));
    let templates: Record<string, string> = {};
    try { templates = JSON.parse((await getSetting(RELANCE2_TEMPLATES_KEY)) ?? "{}"); } catch { /* recreate */ }
    for (const locale of ["fr", "en"] as const) {
      const batch = codes.ready.map((r) => r.event).filter((e) => e.locale === locale);
      if (!batch.length) continue;
      try {
        if (!templates[locale]) {
          const t = await kv<{ data: { id: string } }>("POST", "/templates/", { data: { type: "template", attributes: { name: `Relance paiement 2 code 15 (${locale}) v1`, editor_type: "CODE", html: buildRelance2TemplateHtml(locale) } } });
          templates[locale] = t.data.id;
          await setSetting(RELANCE2_TEMPLATES_KEY, JSON.stringify(templates));
        }
        for (const e of batch) {
          await kv("PATCH", `/profiles/${e.profileId}/`, { data: { type: "profile", id: e.profileId, attributes: { properties: relance2ProfileProps(e, codeOf.get(e.eventId)!, renderItemsHtml(e)) } } });
        }
        batches.push({ kind: "r2", locale, events: batch, templateId: templates[locale], listId: await createList(`Relance paiement auto 2 ${label} ${locale}`, batch.map((e) => e.profileId)) });
      } catch (err) {
        results.push({ kind: "r2", locale, sent: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  if (batches.length) await waitForLists(batches.map((b) => ({ id: b.listId, size: b.events.length })));
  for (const b of batches) {
    try {
      const { subject, preview } = b.kind === "r2" ? relance2Subject(b.locale) : relanceSubject(b.locale);
      const name = b.kind === "r2" ? `Relance paiement auto 2 code ${label} ${b.locale}` : `Relance paiement auto ${label} ${b.locale}`;
      const { campaignId } = await sendCampaign({ name, listId: b.listId, templateId: b.templateId, subject, preview, label: b.kind === "r2" ? "relance-2-code" : "relance" });
      // Saved at once: a timeout after this point must not make the next run send it again.
      const at = now.toISOString();
      state = { ...state, pending: [...state.pending, { campaignId, eventIds: b.events.map((e) => e.eventId), profileIds: b.events.map((e) => e.profileId), at, ...(b.kind === "r2" ? { kind: "r2" as const } : {}) }] };
      for (const e of b.events) {
        if (b.kind === "r2") { state.events2[e.eventId] = at; state.sent2[e.eventId] = at; state.profiles2[e.profileId] = at; }
        else { state.events[e.eventId] = at; state.sent[e.eventId] = at; state.profiles[e.profileId] = at; }
      }
      await setSetting(STATE_KEY, JSON.stringify(state));
      results.push({ kind: b.kind, locale: b.locale, sent: b.events.length, campaignId });
    } catch (err) {
      results.push({ kind: b.kind, locale: b.locale, sent: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const cleaned = await cleanupLists(72, now).catch(() => 0);
  const sent = results.filter((r) => r.kind === "r1").reduce((n, r) => n + r.sent, 0);
  const sent2 = results.filter((r) => r.kind === "r2").reduce((n, r) => n + r.sent, 0);
  return NextResponse.json({ success: results.every((r) => !r.error), checkouts: events.length, candidates: send.length, sent,
    relance2: { enabled: r2On, candidates: r2On ? r2.send.length : 0, sent: sent2 }, results, cleanedLists: cleaned });
}
