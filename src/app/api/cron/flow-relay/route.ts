import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { getSetting, setSetting } from "@/lib/database";
import { kv, STATE_KEY as RELANCE_STATE_KEY } from "@/lib/relance-paiement";
import {
  CHECKOUT_STARTED, PLACED_ORDER, STEPS, campaignStatus, campaignTemplate, cleanupLists, createList, emptyRelayState,
  eventContext, flowsSendingAgain, propKey, pruneRelayState, selectDue, sendCampaign, triggerEvents, waitForLists,
  type RelayState, type TriggerEvent,
} from "@/lib/flow-relay";

/**
 * GET /api/cron/flow-relay — every 15 min. Sends the emails of the Klaviyo flows (welcome, review
 * request, wheel codes, browse abandonment, price drop, abandoned checkout #2, morning report)
 * through campaigns, because the account's flows never send. See src/lib/flow-relay.ts.
 *
 * `?dryRun=1` lists what would go out and sends nothing. Kill switch: settings
 * `flow_relay_enabled` = "0".
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STATE_KEY = "flow_relay_state";
const ENABLED_KEY = "flow_relay_enabled";
const TEMPLATES_KEY = "flow_relay_templates";

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  if (!dryRun && (await getSetting(ENABLED_KEY)) === "0") return NextResponse.json({ success: true, skipped: "disabled" });
  try {
    return await trackCron("flow-relay", () => run(dryRun));
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

async function run(dryRun: boolean) {
  const now = new Date();
  const iso = (min: number) => new Date(now.getTime() - min * 60e3).toISOString().slice(0, 19);
  let state: RelayState | null = null;
  try { const raw = await getSetting(STATE_KEY); if (raw) state = JSON.parse(raw) as RelayState; } catch { /* corrupt → fresh */ }
  const firstRun = !state;
  state = pruneRelayState({ ...emptyRelayState(now), ...(state ?? {}) }, now);

  // 1. campaigns sent last run: a cancelled one ("No Recipients") is retried by forgetting it
  const stillPending: RelayState["pending"] = [];
  for (const p of state.pending) {
    const status = await campaignStatus(p.campaignId).catch(() => "unknown");
    if (/cancel|fail/i.test(status)) {
      for (const id of p.eventIds) delete state.done[p.step]?.[id];
      for (const id of p.profileIds) delete state.prof[p.step]?.[id];
    }
    else if (/queued|scheduled|sending|adding|preparing|unknown/i.test(status)) stillPending.push(p);
  }
  state.pending = stillPending;

  // 2. inputs
  const maxLookback = Math.max(...STEPS.map((s) => s.offsetMin + s.graceMin)) + 60;
  const metrics = [...new Set(STEPS.map((s) => s.metricId))];
  const byMetric = new Map<string, TriggerEvent[]>();
  for (const m of metrics) {
    const lookback = Math.max(...STEPS.filter((s) => s.metricId === m).map((s) => s.offsetMin + s.graceMin)) + 60;
    byMetric.set(m, await triggerEvents(m, iso(Math.min(lookback, maxLookback))));
  }
  const orders = await triggerEvents(PLACED_ORDER, iso(maxLookback));
  const orderTimes = new Map<string, number[]>();
  for (const o of orders) orderTimes.set(o.profileId, [...(orderTimes.get(o.profileId) ?? []), Date.parse(o.at)]);
  const checkouts = byMetric.get(CHECKOUT_STARTED) ?? [];
  const sendingAgain = await flowsSendingAgain(iso(3 * 24 * 60));
  let relance: { events?: Record<string, string> } = {};
  try { relance = JSON.parse((await getSetting(RELANCE_STATE_KEY)) ?? "{}"); } catch { /* none */ }

  const ctx = {
    now, state,
    orderedAfter: (pid: string, at: string) => (orderTimes.get(pid) ?? []).some((t) => t >= Date.parse(at) - 5 * 60e3),
    checkoutWithin24h: (pid: string) => checkouts.some((c) => c.profileId === pid && now.getTime() - Date.parse(c.at) < 24 * 3600e3),
    relancePaiementSent: (id: string) => !!relance.events?.[id],
    flowSendingAgain: (flowId: string) => sendingAgain.has(flowId),
  };
  const due = STEPS.map((step) => ({ step, events: selectDue(step, byMetric.get(step.metricId) ?? [], ctx) })).filter((d) => d.events.length);

  if (dryRun || firstRun) {
    // First run only records startAt: everything due before it was handled by the 2026-10-20 catch-up.
    if (firstRun && !dryRun) await setSetting(STATE_KEY, JSON.stringify(state));
    return NextResponse.json({ success: true, dryRun, firstRun, startAt: state.startAt, flowsSendingAgain: [...sendingAgain],
      due: due.map((d) => ({ step: d.step.key, count: d.events.length, people: d.events.map((e) => e.email?.replace(/^(.).*@/, "$1***@")) })) });
  }

  // 3. send: profile data → one list per step → (one shared wait) → campaigns
  let cache: Record<string, string> = {};
  try { cache = JSON.parse((await getSetting(TEMPLATES_KEY)) ?? "{}"); } catch { /* recreate */ }
  const label = now.toISOString().slice(0, 16).replace("T", " ");
  const ready: Array<{ step: (typeof STEPS)[number]; events: TriggerEvent[]; listId: string; templateId: string }> = [];
  const errors: string[] = [];
  for (const d of due) {
    try {
      const templateId = await campaignTemplate(d.step, cache);
      for (const e of d.events) {
        await kv("PATCH", `/profiles/${e.profileId}/`, { data: { type: "profile", id: e.profileId, attributes: { properties: { [propKey(d.step.flowId)]: eventContext(e.props) } } } });
      }
      ready.push({ ...d, templateId, listId: await createList(`Relais flow ${d.step.key} ${label}`, [...new Set(d.events.map((e) => e.profileId))]) });
    } catch (err) {
      errors.push(`${d.step.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await setSetting(TEMPLATES_KEY, JSON.stringify(cache));
  if (ready.length) await waitForLists(ready.map((r) => ({ id: r.listId, size: new Set(r.events.map((e) => e.profileId)).size })));
  const sent: Array<{ step: string; count: number; campaignId: string }> = [];
  for (const r of ready) {
    try {
      const campaignId = await sendCampaign(r.step, r.listId, r.templateId, label);
      const at = now.toISOString();
      state.done[r.step.key] = { ...(state.done[r.step.key] ?? {}), ...Object.fromEntries(r.events.map((e) => [e.id, at])) };
      state.prof[r.step.key] = { ...(state.prof[r.step.key] ?? {}), ...Object.fromEntries(r.events.map((e) => [e.profileId, at])) };
      state.pending.push({ campaignId, step: r.step.key, eventIds: r.events.map((e) => e.id), profileIds: r.events.map((e) => e.profileId), at });
      sent.push({ step: r.step.key, count: r.events.length, campaignId });
    } catch (err) {
      errors.push(`${r.step.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await setSetting(STATE_KEY, JSON.stringify(state));
  const cleaned = await cleanupLists(72, now).catch(() => 0);
  return NextResponse.json({ success: errors.length === 0, sent, errors, cleanedLists: cleaned, flowsSendingAgain: [...sendingAgain] });
}
