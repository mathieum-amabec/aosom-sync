import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { acquireLease, getSetting, releaseLease, setSetting } from "@/lib/database";
import { CHECKOUT_STARTED_METRIC, PLACED_ORDER_METRIC, STATE_KEY as RELANCE_STATE_KEY, metricId, recentEvents } from "@/lib/relance-paiement";
import {
  ADDED_TO_CART_METRIC, CART_MAX_AGE_H, ENABLED_KEY, MAX_PER_DAY, MAX_PER_RUN, STATE_KEY, TEMPLATES_KEY,
  buildTemplateHtml, cartSubject, emptyState, fetchProfileInfo, parseCartEvent, pruneState, renderItemsHtml, selectCarts,
  type Cart, type CartEvent, type CartRelayState, type SelectCtx,
} from "@/lib/cart-relay";
import {
  RELAY_LEASE_KEY, RELAY_LEASE_TTL_S, assertRenders, campaignStatus, cleanupLists, createList, kv, sendCampaign,
  shouldRetry, stillInFlight, waitForLists,
} from "@/lib/klaviyo-campaigns";

/**
 * GET /api/cron/cart-relay — every 30 min. Emails identified shoppers who ADDED TO CART and neither
 * started a checkout nor ordered, through a Klaviyo CAMPAIGN (see src/lib/cart-relay.ts).
 *
 * OFF BY DEFAULT: nothing is sent unless settings `cart_relay_enabled` = "1". (The other relays are
 * on unless set to "0"; this one is the opposite on purpose.) `?dryRun=1` always works, with the
 * flag on or off, and sends/writes nothing. Shares the relays' lease and saves its state right
 * after the send job, so an invocation can never send the same batch twice.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  if (!dryRun && (await getSetting(ENABLED_KEY)) !== "1") {
    return NextResponse.json({ success: true, skipped: "disabled" });
  }
  const lease = dryRun ? "dry" : await acquireLease(RELAY_LEASE_KEY, RELAY_LEASE_TTL_S);
  if (!lease) return NextResponse.json({ success: true, skipped: "another-relay-running" });
  try {
    return await trackCron("cart-relay", () => run(dryRun));
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  } finally {
    if (!dryRun) await releaseLease(RELAY_LEASE_KEY, lease).catch(() => {});
  }
}

async function loadState(now: Date): Promise<CartRelayState> {
  let s: CartRelayState = emptyState();
  try { s = { ...emptyState(), ...JSON.parse((await getSetting(STATE_KEY)) ?? "{}") }; } catch { /* corrupt → start fresh */ }
  return pruneState(s, now);
}

async function run(dryRun: boolean) {
  const now = new Date();
  let state = await loadState(now);

  // Campaigns of earlier runs: Klaviyo's "No Recipients" cancellation → forget them so they retry.
  if (!dryRun && state.pending.length) {
    const keep: CartRelayState["pending"] = [];
    for (const p of state.pending) {
      const status = await campaignStatus(p.campaignId).catch(() => "unknown");
      if (shouldRetry(status)) {
        for (const id of p.eventIds) delete state.events[id];
        for (const id of p.profileIds) delete state.profiles[id];
        state.sentLog = state.sentLog.slice(0, Math.max(0, state.sentLog.length - p.profileIds.length));
      } else if (stillInFlight(status) || status === "unknown") keep.push(p);
    }
    state.pending = keep;
    await setSetting(STATE_KEY, JSON.stringify(state));
  }

  // The window reaches back past the max age: a cart's checkout/order may come after its first add.
  const since = new Date(now.getTime() - (CART_MAX_AGE_H + 12) * 3600e3).toISOString().slice(0, 19);
  const [cartMetric, checkoutMetric, orderMetric] = await Promise.all([
    metricId(ADDED_TO_CART_METRIC), metricId(CHECKOUT_STARTED_METRIC), metricId(PLACED_ORDER_METRIC)]);
  const [carts, checkouts, orders] = await Promise.all([
    recentEvents(cartMetric, since), recentEvents(checkoutMetric, since), recentEvents(orderMetric, since)]);
  const events = carts.events
    .map((e) => parseCartEvent(e, carts.emails.get(e.relationships?.profile?.data?.id ?? "") ?? null))
    .filter((e): e is CartEvent => e !== null);
  const times = (evs: typeof checkouts.events) => {
    const m = new Map<string, number[]>();
    for (const e of evs) { const pid = e.relationships?.profile?.data?.id; if (pid) m.set(pid, [...(m.get(pid) ?? []), Date.parse(e.attributes.datetime)]); }
    return m;
  };
  const checkoutTimes = times(checkouts.events), orderTimes = times(orders.events);
  const after = (m: Map<string, number[]>) => (pid: string, iso: string) => (m.get(pid) ?? []).some((t) => t >= Date.parse(iso));

  let relanceProfiles: Record<string, string> = {};
  try { relanceProfiles = (JSON.parse((await getSetting(RELANCE_STATE_KEY)) ?? "{}") as { profiles?: Record<string, string> }).profiles ?? {}; } catch { /* none */ }

  const remainingToday = Math.max(0, MAX_PER_DAY - state.sentLog.length);
  const base: Omit<SelectCtx, "canEmail" | "limit"> = { state, relanceProfiles, checkoutAfter: after(checkoutTimes), orderedAfter: after(orderTimes) };
  // pass 1: every rule except consent → only those profiles are looked up in Klaviyo
  const first = selectCarts(events, { ...base, canEmail: () => true, limit: 1000 }, now);
  const info = await fetchProfileInfo(first.send.map((c) => c.profileId));
  const { send, skipped } = selectCarts(events, {
    ...base, canEmail: (pid) => info.get(pid)?.allowed === true, profileLocale: (pid) => info.get(pid)?.locale ?? null,
    limit: Math.min(MAX_PER_RUN, remainingToday),
  }, now);

  if (dryRun) {
    return NextResponse.json({ success: true, dryRun: true, enabled: (await getSetting(ENABLED_KEY)) === "1", cartEvents: events.length, remainingToday,
      wouldSend: send.map((c) => ({ at: c.at, locale: c.locale, items: c.items.map((i) => i.title), email: c.email?.replace(/^(.).*@/, "$1***@") })),
      skipped: skipped.reduce<Record<string, number>>((m, s) => ({ ...m, [s.reason]: (m[s.reason] ?? 0) + 1 }), {}) });
  }
  for (const s of skipped) if (s.final) for (const id of s.eventIds) state.events[id] = now.toISOString();
  await setSetting(STATE_KEY, JSON.stringify(state));

  const results: Array<{ locale: string; sent: number; campaignId?: string; error?: string }> = [];
  if (send.length) {
    let templates: Record<string, string> = {};
    try { templates = JSON.parse((await getSetting(TEMPLATES_KEY)) ?? "{}"); } catch { /* recreate */ }
    const label = now.toISOString().slice(0, 16).replace("T", " ");
    const batches: Array<{ locale: "fr" | "en"; carts: Cart[]; listId: string }> = [];
    for (const locale of ["fr", "en"] as const) {
      const batch = send.filter((c) => c.locale === locale);
      if (!batch.length) continue;
      try {
        if (!templates[locale]) {
          const t = await kv<{ data: { id: string } }>("POST", "/templates/", { data: { type: "template", attributes: { name: `Panier abandonné auto (${locale}) v1`, editor_type: "CODE", html: buildTemplateHtml(locale) } } });
          templates[locale] = t.data.id;
          await setSetting(TEMPLATES_KEY, JSON.stringify(templates));
        }
        // a template Klaviyo would accept but skip for every recipient is caught here, before anyone is mailed
        await assertRenders(templates[locale], { cart_relay_items_html: renderItemsHtml(batch[0]), cart_relay_url: batch[0].url });
        for (const c of batch) {
          await kv("PATCH", `/profiles/${c.profileId}/`, { data: { type: "profile", id: c.profileId, attributes: { properties: {
            cart_relay_url: c.url, cart_relay_items_html: renderItemsHtml(c), cart_relay_at: c.at,
          } } } });
        }
        // "Relance paiement auto" prefix: the shared cleanupLists() deletes these one-shot lists after 72 h
        batches.push({ locale, carts: batch, listId: await createList(`Relance paiement auto panier ${label} ${locale}`, batch.map((c) => c.profileId)) });
      } catch (err) {
        results.push({ locale, sent: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (batches.length) await waitForLists(batches.map((b) => ({ id: b.listId, size: b.carts.length })));
    for (const b of batches) {
      try {
        const { subject, preview } = cartSubject(b.locale);
        const { campaignId } = await sendCampaign({ name: `Panier abandonné auto ${label} ${b.locale}`, listId: b.listId, templateId: templates[b.locale], subject, preview, label: "panier" });
        // Saved at once: a timeout after this point must not make the next run send it again.
        const at = now.toISOString();
        state = { ...state, pending: [...state.pending, { campaignId, eventIds: b.carts.flatMap((c) => c.eventIds), profileIds: b.carts.map((c) => c.profileId), at }],
          sentLog: [...state.sentLog, ...b.carts.map(() => at)] };
        for (const c of b.carts) { for (const id of c.eventIds) state.events[id] = at; state.profiles[c.profileId] = at; }
        await setSetting(STATE_KEY, JSON.stringify(state));
        results.push({ locale: b.locale, sent: b.carts.length, campaignId });
      } catch (err) {
        results.push({ locale: b.locale, sent: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  const cleaned = await cleanupLists(72, now).catch(() => 0);
  return NextResponse.json({ success: results.every((r) => !r.error), cartEvents: events.length, candidates: send.length, sent: results.reduce((n, r) => n + r.sent, 0), results, cleanedLists: cleaned });
}
