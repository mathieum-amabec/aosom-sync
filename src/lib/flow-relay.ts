/**
 * Flow relay — sends the emails of Klaviyo FLOWS through Klaviyo CAMPAIGNS.
 *
 * The Klaviyo account never sends flow emails (no flow has ever produced a Received Email; triggers
 * arrive, nothing is sent, skipped or dropped — verified 2026-10-20), while campaigns go out. This
 * relay replays each live flow: for every trigger event whose step is due, it copies the event's
 * data onto the profile (`rl_<flowId>`), and sends a one-batch campaign whose template is the flow's
 * own template with `event` rewritten to read that profile property.
 *
 * Abandoned-checkout reminder #1 stays in relance-paiement.ts (its own template); reminder #2 is
 * relayed here. If a flow starts sending by itself again (a "Received Email" carrying its $flow id),
 * its steps stop being relayed automatically, so nobody gets the same email twice.
 *
 * Only steps due AFTER the relay's first run are sent: everything older was handled by the one-off
 * catch-up of 2026-10-20.
 */
import { kv } from "./relance-paiement";

export interface RelayStep {
  key: string;
  flowId: string;
  /** Klaviyo metric id of the trigger. */
  metricId: string;
  /** Only events whose properties match (e.g. subscriptions to a given list). */
  match?: (props: Record<string, unknown>) => boolean;
  offsetMin: number;
  /** Give up on a step this long after it was due (stale emails are worse than none). */
  graceMin: number;
  templateId: string;
  subject: string;
  preview: string;
  /** Skip if the profile placed an order after the trigger. */
  noOrderSinceTrigger?: boolean;
  /** Skip if the profile started a checkout in the last 24 h (browse abandonment). */
  noRecentCheckout?: boolean;
  /** At most one email of this step per profile in this window. */
  cooldownH?: number;
  /** Abandoned checkout #2: only after reminder #1 actually went out. */
  requiresRelancePaiement?: boolean;
}

const H = 60, D = 24 * 60;
export const PLACED_ORDER = "SbdeEU";
export const CHECKOUT_STARTED = "Rycc4h";
export const RECEIVED_EMAIL = "SCXLAK";

export const STEPS: RelayStep[] = [
  { key: "checkout-2", flowId: "Xw6R8f", metricId: CHECKOUT_STARTED, offsetMin: D, graceMin: D, templateId: "Y4uDpu",
    subject: "Toujours intéressé·e ? 🔥 / Still interested?", preview: "", noOrderSinceTrigger: true, cooldownH: 72, requiresRelancePaiement: true },
  { key: "review", flowId: "ULN3my", metricId: "VL4ZFS", offsetMin: 10 * D, graceMin: 3 * D, templateId: "VWcSfq",
    subject: "Comment trouves-tu ton achat ? ⭐ / How's your purchase?", preview: "", cooldownH: 30 * 24 },
  { key: "welcome-1", flowId: "XJghtC", metricId: "QYnDET", match: (p) => p.list_id === "Sm4Zq4", offsetMin: 10, graceMin: 2 * D, templateId: "Wuecen",
    subject: "Bienvenue chez Ameublo Direct ! 🎉 / Welcome to Furnish Direct!", preview: "", noOrderSinceTrigger: true, cooldownH: 365 * 24 },
  { key: "welcome-2", flowId: "XJghtC", metricId: "QYnDET", match: (p) => p.list_id === "Sm4Zq4", offsetMin: 3 * D + 10, graceMin: 2 * D, templateId: "Wj7cEE",
    subject: "Notre histoire (et pourquoi on fait ça) / Our story", preview: "", cooldownH: 365 * 24 },
  { key: "roue-1", flowId: "WmUVfQ", metricId: "V5gzPH", offsetMin: 10, graceMin: D, templateId: "XxjL9G",
    subject: "🎁 Ton code : {{ event.prize_fr }} / Your code: {{ event.prize_en }}", preview: "Valide 72 h — appliqué en un clic. / Valid 72 h — applied in one click.", noOrderSinceTrigger: true },
  { key: "roue-2", flowId: "WmUVfQ", metricId: "V5gzPH", offsetMin: D + 10, graceMin: 12 * H, templateId: "QU22nZ",
    subject: "Ton code {{ event.code }} expire dans 48 h / Your code expires in 48 h", preview: "{{ event.prize_fr }} t'attend encore. / {{ event.prize_en }} is still waiting.", noOrderSinceTrigger: true },
  { key: "roue-3", flowId: "WmUVfQ", metricId: "V5gzPH", offsetMin: D + 10 + 36 * H, graceMin: 10 * H, templateId: "WhhEUs",
    subject: "⏰ Dernières heures pour {{ event.prize_fr }} / Last hours for {{ event.prize_en }}", preview: "Ton code expire bientôt. / Your code expires soon.", noOrderSinceTrigger: true },
  { key: "browse", flowId: "QYEyd8", metricId: "Y6SFtA", offsetMin: 3 * H, graceMin: 12 * H, templateId: "Sa5p6Y",
    subject: "Toujours en train d'y penser ? / Still thinking it over?", preview: "Le produit que vous avez regardé vous attend. / The item you viewed is still here.",
    noOrderSinceTrigger: true, noRecentCheckout: true, cooldownH: 7 * 24 },
  { key: "price-drop", flowId: "W34UkT", metricId: "SVCFpn", offsetMin: 0, graceMin: D, templateId: "RPc6Hi",
    subject: "Bonne nouvelle — le prix a baissé ! 💸 / Price drop alert!", preview: "" },
  { key: "morning-report", flowId: "X49Zbn", metricId: "V7i73U", offsetMin: 0, graceMin: 6 * H, templateId: "TnEXP2",
    subject: "{{ event.subject }}", preview: "" },
];

export const propKey = (flowId: string) => `rl_${flowId}`;
const INTERNAL = /^qa-|@ameublodirect\.ca$/i;

// ─── template rewriting (pure) ─────────────────────────────────────────

/** `event.a.b` / `event|lookup:'x'` inside template tags → read from the profile property instead. */
export function rewriteBody(html: string, flowId: string): string {
  if (!/\{[{%][^}]*\bevent\b/.test(html)) return html;
  const body = html.replace(/\{([{%])([\s\S]*?)([}%])\}/g, (_m, a: string, inner: string, b: string) => `{${a}${inner.replace(/\bevent\b/g, "ev")}${b}}`);
  return `{% with ev=person|lookup:'${propKey(flowId)}' %}${body}{% endwith %}`;
}

/** Subject/preview lines can't hold a `{% with %}`: chain lookups instead. */
export function rewriteLine(line: string, flowId: string): string {
  return line.replace(/\{\{([\s\S]*?)\}\}/g, (_m, inner: string) => `{{${inner.replace(/\bevent((?:\.[A-Za-z0-9_]+)+)/g, (_x, path: string) =>
    `person|lookup:'${propKey(flowId)}'` + path.split(".").slice(1).map((k) => `|lookup:'${k}'`).join(""))}}}`);
}

/** Event properties as the flow template sees them (`$extra` → `extra`), trimmed for profile storage. */
export function eventContext(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === "$extra") continue;
    if (k.startsWith("$") && k !== "$value") continue;
    out[k] = v;
  }
  const extra = props.$extra as Record<string, unknown> | undefined;
  if (extra) {
    const lines = Array.isArray(extra.line_items) ? (extra.line_items as Array<Record<string, unknown>>) : [];
    out.extra = {
      checkout_url: extra.checkout_url,
      line_items: lines.slice(0, 6).map((l) => {
        const p = (l.product ?? {}) as { handle?: string; images?: Array<{ src?: string; thumb_src?: string }> };
        return { title: l.title, presentment_title: l.presentment_title, quantity: l.quantity, line_price: l.line_price,
          product: { handle: p.handle, images: (p.images ?? []).slice(0, 1).map((i) => ({ src: i.src, thumb_src: i.thumb_src })) } };
      }),
    };
  }
  return out;
}

// ─── selection (pure) ──────────────────────────────────────────────────

export interface TriggerEvent { id: string; profileId: string; email: string | null; at: string; props: Record<string, unknown> }
export interface RelayState {
  startAt: string;
  done: Record<string, Record<string, string>>; // step → event id → iso
  prof: Record<string, Record<string, string>>; // step → profile id → iso
  pending: Array<{ campaignId: string; step: string; eventIds: string[]; profileIds: string[]; at: string }>;
}
export const emptyRelayState = (now: Date): RelayState => ({ startAt: now.toISOString(), done: {}, prof: {}, pending: [] });

export interface Ctx {
  now: Date;
  state: RelayState;
  orderedAfter: (profileId: string, iso: string) => boolean;
  checkoutWithin24h: (profileId: string) => boolean;
  relancePaiementSent: (eventId: string) => boolean;
  flowSendingAgain: (flowId: string) => boolean;
}

export function selectDue(step: RelayStep, events: TriggerEvent[], c: Ctx): TriggerEvent[] {
  if (c.flowSendingAgain(step.flowId)) return [];
  const done = c.state.done[step.key] ?? {}, prof = c.state.prof[step.key] ?? {};
  const start = Date.parse(c.state.startAt), now = c.now.getTime();
  const picked = new Set<string>(), out: TriggerEvent[] = [];
  for (const e of [...events].sort((a, b) => b.at.localeCompare(a.at))) {
    const due = Date.parse(e.at) + step.offsetMin * 60e3;
    if (done[e.id] || due > now || due < start || now - due > step.graceMin * 60e3) continue;
    if (!e.email || INTERNAL.test(e.email)) continue;
    if (step.match && !step.match(e.props)) continue;
    if (step.noOrderSinceTrigger && c.orderedAfter(e.profileId, e.at)) continue;
    if (step.noRecentCheckout && c.checkoutWithin24h(e.profileId)) continue;
    if (step.requiresRelancePaiement && !c.relancePaiementSent(e.id)) continue;
    const last = prof[e.profileId];
    if (picked.has(e.profileId) || (step.cooldownH && last && now - Date.parse(last) < step.cooldownH * 3600e3)) continue;
    picked.add(e.profileId);
    out.push(e);
  }
  return out;
}

/** Forget bookkeeping older than 15 days (the longest step is review at 10 d + 3 d grace). */
export function pruneRelayState(s: RelayState, now: Date): RelayState {
  const min = now.getTime() - 15 * 24 * 3600e3;
  const keep = (o: Record<string, Record<string, string>>) => Object.fromEntries(Object.entries(o).map(([k, m]) => [k, Object.fromEntries(Object.entries(m).filter(([, t]) => Date.parse(t) >= min))]));
  const cool = (o: Record<string, Record<string, string>>) => Object.fromEntries(Object.entries(o).map(([k, m]) => [k, Object.fromEntries(Object.entries(m).filter(([, t]) => Date.parse(t) >= now.getTime() - 366 * 24 * 3600e3))]));
  return { ...s, done: keep(s.done), prof: cool(s.prof), pending: s.pending.filter((p) => Date.parse(p.at) >= now.getTime() - 2 * 24 * 3600e3) };
}

// ─── Klaviyo IO ────────────────────────────────────────────────────────

type RawEvent = { id: string; attributes: { datetime: string; event_properties: Record<string, unknown> }; relationships?: { profile?: { data?: { id: string } } } };
const BASE = "https://a.klaviyo.com/api";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function triggerEvents(metricId: string, sinceIso: string): Promise<TriggerEvent[]> {
  const out: TriggerEvent[] = [];
  let path: string | null = `/events/?filter=${encodeURIComponent(`and(equals(metric_id,"${metricId}"),greater-than(datetime,${sinceIso}))`)}&sort=-datetime&include=profile&fields[profile]=email&page[size]=100`;
  while (path) {
    const j: { data: RawEvent[]; included?: Array<{ id: string; attributes: { email?: string } }>; links?: { next?: string } } = await kv("GET", path);
    const emails = new Map((j.included ?? []).map((p) => [p.id, p.attributes.email ?? null]));
    for (const e of j.data) {
      const pid = e.relationships?.profile?.data?.id;
      if (pid) out.push({ id: e.id, profileId: pid, email: emails.get(pid) ?? null, at: e.attributes.datetime, props: e.attributes.event_properties ?? {} });
    }
    path = j.links?.next ? j.links.next.replace(BASE, "") : null;
  }
  return out;
}

/** Flow ids that delivered an email by themselves recently (Klaviyo fixed) → stop relaying them. */
export async function flowsSendingAgain(sinceIso: string): Promise<Set<string>> {
  const ev = await triggerEvents(RECEIVED_EMAIL, sinceIso);
  return new Set(ev.map((e) => String(e.props.$flow ?? "")).filter(Boolean));
}

export async function campaignTemplate(step: RelayStep, cache: Record<string, string>): Promise<string> {
  const src = await kv<{ data: { attributes: { html: string; updated: string } } }>("GET", `/templates/${step.templateId}/`);
  const cacheKey = `${step.key}:${step.templateId}:${src.data.attributes.updated}`;
  if (cache[cacheKey]) return cache[cacheKey];
  const t = await kv<{ data: { id: string } }>("POST", "/templates/", { data: { type: "template", attributes: {
    name: `Relais flow ${step.key} (${step.templateId})`, editor_type: "CODE", html: rewriteBody(src.data.attributes.html, step.flowId) } } });
  for (const k of Object.keys(cache)) if (k.startsWith(`${step.key}:`)) delete cache[k];
  cache[cacheKey] = t.data.id;
  return t.data.id;
}

export async function createList(name: string, profileIds: string[]): Promise<string> {
  const list = await kv<{ data: { id: string } }>("POST", "/lists/", { data: { type: "list", attributes: { name } } });
  for (let i = 0; i < profileIds.length; i += 100) {
    await kv("POST", `/lists/${list.data.id}/relationships/profiles/`, { data: profileIds.slice(i, i + 100).map((id) => ({ type: "profile", id })) });
  }
  return list.data.id;
}

export async function waitForLists(lists: Array<{ id: string; size: number }>): Promise<void> {
  for (let i = 0; i < 12; i++) {
    let ready = true;
    for (const l of lists) {
      const m = await kv<{ data: unknown[] }>("GET", `/lists/${l.id}/profiles/?page[size]=100`);
      if (m.data.length < Math.min(100, l.size)) ready = false;
    }
    if (ready) break;
    await sleep(5000);
  }
  // A campaign sent the instant the list is filled is cancelled "No Recipients" (seen 2026-10-20).
  await sleep(45_000);
}

export async function sendCampaign(step: RelayStep, listId: string, templateId: string, label: string): Promise<string> {
  const camp = await kv<{ data: { id: string; relationships: { "campaign-messages": { data: Array<{ id: string }> } } } }>("POST", "/campaigns/", { data: { type: "campaign", attributes: {
    name: `Relais flow ${step.key} ${label}`,
    audiences: { included: [listId], excluded: [] },
    send_strategy: { method: "immediate" },
    "campaign-messages": { data: [{ type: "campaign-message", attributes: { channel: "email", label: step.key, content: {
      subject: rewriteLine(step.subject, step.flowId), preview_text: rewriteLine(step.preview, step.flowId),
      from_email: "info@ameublodirect.ca", from_label: "Ameublo Direct" } } }] },
  } } });
  await kv("POST", "/campaign-message-assign-template/", { data: { type: "campaign-message", id: camp.data.relationships["campaign-messages"].data[0].id, relationships: { template: { data: { type: "template", id: templateId } } } } });
  await kv("POST", "/campaign-send-jobs/", { data: { type: "campaign-send-job", id: camp.data.id } });
  return camp.data.id;
}

export async function campaignStatus(id: string): Promise<string> {
  const c = await kv<{ data: { attributes: { status: string } } }>("GET", `/campaigns/${id}/`);
  return c.data.attributes.status;
}

/** Delete the one-shot lists this relay (and relance-paiement) made, once their campaign is old. */
export async function cleanupLists(olderThanH: number, now: Date): Promise<number> {
  const lists: Array<{ id: string; attributes: { name: string; created: string } }> = [];
  let path: string | null = "/lists/?fields[list]=name,created";
  while (path) {
    const j: { data: typeof lists; links?: { next?: string } } = await kv("GET", path);
    lists.push(...j.data);
    path = j.links?.next ? j.links.next.replace(BASE, "") : null;
  }
  let n = 0;
  for (const l of lists) {
    if (!/^(Relais flow|Relance paiement auto) /.test(l.attributes.name)) continue;
    if (now.getTime() - Date.parse(l.attributes.created) < olderThanH * 3600e3) continue;
    await kv("DELETE", `/lists/${l.id}/`);
    n++;
  }
  return n;
}
