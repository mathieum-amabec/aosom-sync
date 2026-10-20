import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { getSetting, setSetting } from "@/lib/database";
import {
  CHECKOUT_STARTED_METRIC, ENABLED_KEY, PLACED_ORDER_METRIC, RELANCE_MAX_AGE_H, STATE_KEY, TEMPLATES_KEY,
  buildTemplateHtml, campaignWentOut, emptyState, kv, metricId, parseCheckoutEvent, pruneState, recentEvents, renderItemsHtml,
  selectCandidates, sendRelanceCampaign, type CheckoutEvent, type RelanceState,
} from "@/lib/relance-paiement";
import { flowsSendingAgain } from "@/lib/flow-relay";

const ABANDONED_CHECKOUT_FLOW = "Xw6R8f";

/**
 * GET /api/cron/relance-paiement — every 15 min. Emails people who started a Shopify checkout
 * and did not pay, through a one-recipient Klaviyo CAMPAIGN (the account's flows never send —
 * see src/lib/relance-paiement.ts).
 *
 * `?dryRun=1` lists who would get a reminder and sends nothing. Kill switch: settings
 * `relance_paiement_enabled` = "0".
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  if (!dryRun && (await getSetting(ENABLED_KEY)) === "0") {
    return NextResponse.json({ success: true, skipped: "disabled" });
  }
  try {
    return await run(dryRun);
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

async function run(dryRun: boolean) {
  return trackCron("relance-paiement", async () => {
    const now = new Date();
    // If Klaviyo's own Abandoned Checkout flow delivers again, stop: the customer would get both.
    if ((await flowsSendingAgain(new Date(now.getTime() - 3 * 24 * 3600e3).toISOString().slice(0, 19))).has(ABANDONED_CHECKOUT_FLOW)) {
      return NextResponse.json({ success: true, skipped: "klaviyo-flow-sending-again" });
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

    let state: RelanceState = emptyState();
    try { state = { ...emptyState(), ...JSON.parse((await getSetting(STATE_KEY)) ?? "{}") }; } catch { /* corrupt → start fresh */ }
    state = pruneState(state, now);
    const { send, skipped } = selectCandidates(events, state, orderedAfter, now);

    if (dryRun) {
      return NextResponse.json({ success: true, dryRun: true, checkouts: events.length,
        wouldSend: send.map((e) => ({ at: e.at, locale: e.locale, value: e.value, items: e.items.map((i) => i.title), email: e.email?.replace(/^(.).*@/, "$1***@") })),
        skipped: skipped.reduce<Record<string, number>>((m, s) => ({ ...m, [s.reason]: (m[s.reason] ?? 0) + 1 }), {}) });
    }
    for (const s of skipped) if (s.final && s.reason !== "done") state.events[s.eventId] = now.toISOString();

    const results: Array<{ locale: string; sent: number; status: string; campaignId?: string; error?: string }> = [];
    if (send.length) {
      let templates: Record<string, string> = {};
      try { templates = JSON.parse((await getSetting(TEMPLATES_KEY)) ?? "{}"); } catch { /* recreate */ }
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
          const label = now.toISOString().slice(0, 16).replace("T", " ");
          const r = await sendRelanceCampaign(locale, templates[locale], batch.map((e) => e.profileId), label);
          const ok = campaignWentOut(r.status);
          if (ok) for (const e of batch) { state.events[e.eventId] = now.toISOString(); state.profiles[e.profileId] = now.toISOString(); }
          results.push({ locale, sent: ok ? batch.length : 0, status: r.status, campaignId: r.campaignId });
        } catch (err) {
          results.push({ locale, sent: 0, status: "error", error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    await setSetting(STATE_KEY, JSON.stringify(state));
    const sent = results.reduce((n, r) => n + r.sent, 0);
    return NextResponse.json({ success: results.every((r) => r.status !== "error"), checkouts: events.length, candidates: send.length, sent, results });
  });
}
