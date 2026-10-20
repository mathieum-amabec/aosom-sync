/**
 * Flow relay — sends the emails of Klaviyo FLOWS through Klaviyo CAMPAIGNS.
 *
 * The Klaviyo account never sends flow emails (no flow has ever produced a Received Email; triggers
 * arrive, nothing is sent, skipped or dropped — re-verified 2026-10-20 even with a valid template),
 * while campaigns go out. This relay replays each flow step: for every trigger event whose step is
 * due, it copies the event's data onto the profile (`rl_<step>`), and sends a campaign whose
 * template is the flow's own template, fixed (see `rewriteBody`) and rewritten to read that property.
 *
 * Abandoned-checkout reminder #1 stays in relance-paiement.ts (its own template); reminder #2 is
 * relayed here. A flow that starts delivering by itself again stops being relayed.
 *
 * Only steps due after RELAY_START_AT are sent: everything older was handled by the one-off
 * catch-up of 2026-10-20 (finished 22:35 UTC).
 */
import { metricEvents } from "./klaviyo-campaigns";

export const RELAY_START_AT = "2026-10-20T22:36:00.000Z";

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
  /** Skip if the profile won the wheel in the last 7 days (two competing codes). */
  noRecentWheelWin?: boolean;
  /** At most one email of this step per profile in this window. */
  cooldownH?: number;
  /** Abandoned checkout #2: only after reminder #1 really went out. */
  requiresRelancePaiement?: boolean;
}

const H = 60, D = 24 * 60;
export const PLACED_ORDER = "SbdeEU";
export const CHECKOUT_STARTED = "Rycc4h";
export const WHEEL_WON = "V5gzPH";

/**
 * Browse abandonment (QYEyd8) is deliberately NOT relayed: a product view by someone who never
 * subscribed nor bought gives no CASL consent basis, and Viewed Product barely fires anyway.
 */
export const STEPS: RelayStep[] = [
  { key: "checkout-2", flowId: "Xw6R8f", metricId: CHECKOUT_STARTED, offsetMin: D, graceMin: D, templateId: "Y4uDpu",
    subject: "Toujours intéressé·e ? 🔥 / Still interested?", preview: "", noOrderSinceTrigger: true, cooldownH: 72, requiresRelancePaiement: true },
  { key: "review", flowId: "ULN3my", metricId: "VL4ZFS", offsetMin: 10 * D, graceMin: 3 * D, templateId: "VWcSfq",
    subject: "Comment trouves-tu ton achat ? ⭐ / How's your purchase?", preview: "", cooldownH: 30 * 24 },
  { key: "welcome-1", flowId: "XJghtC", metricId: "QYnDET", match: (p) => p.list_id === "Sm4Zq4", offsetMin: 10, graceMin: 2 * D, templateId: "Wuecen",
    subject: "Bienvenue chez Ameublo Direct ! 🎉 / Welcome to Furnish Direct!", preview: "", noOrderSinceTrigger: true, noRecentWheelWin: true, cooldownH: 365 * 24 },
  { key: "welcome-2", flowId: "XJghtC", metricId: "QYnDET", match: (p) => p.list_id === "Sm4Zq4", offsetMin: 3 * D + 10, graceMin: 2 * D, templateId: "Wj7cEE",
    subject: "Notre histoire (et pourquoi on fait ça) / Our story", preview: "", cooldownH: 365 * 24 },
  { key: "roue-1", flowId: "WmUVfQ", metricId: WHEEL_WON, match: (p) => typeof p.code === "string" && !!p.code, offsetMin: 10, graceMin: D, templateId: "XxjL9G",
    subject: "🎁 Ton code : {{ event.prize_fr }} / Your code: {{ event.prize_en }}", preview: "Valide 72 h — appliqué en un clic. / Valid 72 h — applied in one click.", noOrderSinceTrigger: true },
  { key: "roue-2", flowId: "WmUVfQ", metricId: WHEEL_WON, match: (p) => typeof p.code === "string" && !!p.code, offsetMin: D + 10, graceMin: 3 * H, templateId: "QU22nZ",
    subject: "Ton code {{ event.code }} expire dans 48 h / Your code expires in 48 h", preview: "{{ event.prize_fr }} t'attend encore. / {{ event.prize_en }} is still waiting.", noOrderSinceTrigger: true },
  { key: "roue-3", flowId: "WmUVfQ", metricId: WHEEL_WON, match: (p) => typeof p.code === "string" && !!p.code, offsetMin: D + 10 + 36 * H, graceMin: 2 * H, templateId: "WhhEUs",
    subject: "⏰ Dernières heures pour {{ event.prize_fr }} / Last hours for {{ event.prize_en }}", preview: "Ton code expire bientôt. / Your code expires soon.", noOrderSinceTrigger: true },
  { key: "price-drop", flowId: "W34UkT", metricId: "SVCFpn", offsetMin: 0, graceMin: D, templateId: "RPc6Hi",
    subject: "Bonne nouvelle — le prix a baissé ! 💸 / Price drop alert!", preview: "" },
  { key: "morning-report", flowId: "X49Zbn", metricId: "V7i73U", offsetMin: 0, graceMin: 6 * H, templateId: "TnEXP2",
    subject: "{{ event.subject }}", preview: "" },
];

export const propKey = (step: Pick<RelayStep, "key">) => `rl_${step.key.replace(/-/g, "_")}`;
const INTERNAL = /^qa-|^ops-|@ameublodirect\.ca$/i;

// ─── template rewriting (pure) ─────────────────────────────────────────

/**
 * Text fixes applied to every relayed template (the Klaviyo sources stay as they are):
 * returns now cost 10 % + the return label (since 2026-10-16), the price-drop "quantities are
 * limited" claim is unsupported, the review email goes out 10 days after shipping, and the
 * 2nd-item discount applies to the cheaper of the two items.
 */
const TEXT_FIXES: Array<[RegExp, string]> = [
  [/Retours\s+acceptés\s+pendant\s+30\s+jours/g, "Retours sous 30 jours (frais de 10 % + étiquette de retour)"],
  [/Retours\s+30\s+jours/g, "Retours sous 30 jours (frais de 10 % + étiquette)"],
  [/30-day\s+returns(?!\s*\()/g, "30-day returns (10% fee + return label)"],
  [/\s*Les quantités sont limitées — profites-en avant que le prix ne remonte\./g, ""],
  [/\s*Quantities are limited — grab it before the price goes back up\./g, ""],
  [/Ta commande est en route depuis quelques jours — on espère qu'elle te plaît !/g, "Ta commande est arrivée ? On espère qu'elle te plaît !"],
  [/Your order has been on its way for a few days — we hope you love it!/g, "Has your order arrived? We hope you love it!"],
  [/ajoute un 2<sup>e<\/sup> article et il passe à\s*10 % de rabais/g, "ajoute un 2<sup>e</sup> article : le moins cher des deux est à 10 % de rabais"],
  [/\bevent\.url\|/g, "event.product_url|"],
];

/**
 * Make a flow template sendable as a campaign:
 * - `{% unsubscribe %}text{% endunsubscribe %}` is not valid Klaviyo syntax: every recipient is
 *   skipped "Email Syntax Error" (40/40 review requests on 2026-10-20) → `{% unsubscribe 'text' %}`;
 * - text fixes above;
 * - `event…` inside tags reads the profile property, inside `{% with %}` placed in <body> (wrapping
 *   the doctype makes Klaviyo drop it and move <head> content into the body).
 */
export function rewriteBody(html: string, key: string): string {
  let out = html.replace(/\{%\s*unsubscribe\s*%\}([\s\S]*?)\{%\s*endunsubscribe\s*%\}/g, (_m, txt: string) => `{% unsubscribe '${txt.trim().replace(/'/g, "’")}' %}`);
  for (const [re, to] of TEXT_FIXES) out = out.replace(re, to);
  if (!/\{[{%][^}]*\bevent\b/.test(out)) return out;
  out = out.replace(/\{([{%])([\s\S]*?)([}%])\}/g, (_m, a: string, inner: string, b: string) => `{${a}${inner.replace(/\bevent\b/g, "ev")}${b}}`);
  const open = `{% with ev=person|lookup:'${key}' %}`;
  const body = out.match(/<body[^>]*>/i);
  if (body && /<\/body>/i.test(out)) {
    return out.replace(body[0], body[0] + open).replace(/<\/body>/i, "{% endwith %}</body>");
  }
  return `${open}${out}{% endwith %}`;
}

/** Subject/preview lines can't hold a `{% with %}`: chain lookups instead. */
export function rewriteLine(line: string, key: string): string {
  return line.replace(/\{\{([\s\S]*?)\}\}/g, (_m, inner: string) => `{{${inner.replace(/\bevent((?:\.[A-Za-z0-9_]+)+)/g, (_x, path: string) =>
    `person|lookup:'${key}'` + path.split(".").slice(1).map((k) => `|lookup:'${k}'`).join(""))}}}`);
}

/** Does this step need the event data on the profile at all? */
export const usesEvent = (html: string, step: Pick<RelayStep, "subject" | "preview">) =>
  /\{[{%][^}]*\bevent\b/.test(html) || /\bevent\./.test(step.subject + step.preview);

/** Event properties as the flow template sees them (`$extra` → `extra`), trimmed for profile storage. */
export function eventContext(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === "$extra" || k === "ip_address" || k === "email_address") continue;
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
export interface PendingCampaign { campaignId: string; messageId: string; step: string; eventIds: string[]; profileIds: string[]; at: string }
export interface RelayState {
  startAt: string;
  done: Record<string, Record<string, string>>; // step → event id → iso
  prof: Record<string, Record<string, string>>; // step → profile id → iso
  pending: PendingCampaign[];
  /** campaigns Klaviyo accepted but whose recipients it skipped (template error…), for the dashboard */
  failures: Array<{ step: string; campaignId: string; skipped: number; reason: string; at: string }>;
}
export const emptyRelayState = (): RelayState => ({ startAt: RELAY_START_AT, done: {}, prof: {}, pending: [], failures: [] });

export interface Ctx {
  now: Date;
  state: RelayState;
  orderedAfter: (profileId: string, iso: string) => boolean;
  wonWheelWithin7d: (profileId: string) => boolean;
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
    if (step.noRecentWheelWin && c.wonWheelWithin7d(e.profileId)) continue;
    if (step.requiresRelancePaiement && !c.relancePaiementSent(e.id)) continue;
    const last = prof[e.profileId];
    if (picked.has(e.profileId) || (step.cooldownH && last && now - Date.parse(last) < step.cooldownH * 3600e3)) continue;
    picked.add(e.profileId);
    out.push(e);
  }
  return out;
}

/** Forget bookkeeping that can no longer matter: `done` after 15 days (review = 10 d + 3 d grace),
 * a profile's last send once the step's cooldown is over. */
export function pruneRelayState(s: RelayState, now: Date): RelayState {
  const t = now.getTime();
  const done = Object.fromEntries(Object.entries(s.done).map(([k, m]) => [k, Object.fromEntries(Object.entries(m).filter(([, at]) => t - Date.parse(at) < 15 * 24 * 3600e3))]));
  const prof = Object.fromEntries(Object.entries(s.prof).map(([k, m]) => {
    const keepH = STEPS.find((x) => x.key === k)?.cooldownH ?? 0;
    return [k, Object.fromEntries(Object.entries(m).filter(([, at]) => t - Date.parse(at) < keepH * 3600e3))];
  }));
  return { ...s, done, prof, pending: s.pending.filter((p) => t - Date.parse(p.at) < 2 * 24 * 3600e3), failures: (s.failures ?? []).slice(-20) };
}

// ─── Klaviyo IO ────────────────────────────────────────────────────────

export async function triggerEvents(metricId: string, sinceIso: string): Promise<TriggerEvent[]> {
  const { events, emails } = await metricEvents(metricId, sinceIso);
  return events.flatMap((e) => {
    const pid = e.relationships?.profile?.data?.id;
    return pid ? [{ id: e.id, profileId: pid, email: emails.get(pid) ?? null, at: e.attributes.datetime, props: e.attributes.event_properties ?? {} }] : [];
  });
}
