/**
 * Flow emails on our own engine: who gets which email, when (same timing and guards as the Klaviyo
 * relays, reused from flow-relay.ts), rendered by templates.ts, sent by engine.ts.
 *
 * Hand-over from the relays, one group at a time, without anyone getting an email twice:
 *   - settings `email_engine_takeover` = JSON {group: ISO time the engine took it over};
 *   - in mode "live" with a complete configuration, a taken-over group is skipped by the relays
 *     (`loadRelayKeysOwnedByEngine`, which throws rather than guess) and handled here;
 *   - both sides read each other's bookkeeping on EVERY run: the engine skips what the relays
 *     handled and honours their cooldowns, and the relays skip what the engine handled
 *     (`mergeEngineIntoRelay` / `mergeEngineIntoRelance`). So a group moving back to the relays
 *     (unticked, mode left "live", configuration broken) never resends anything;
 *   - mode "test" keeps its own state (`TEST_STATE_KEY`): only the test recipients get anything and
 *     the relays keep serving real customers, untouched.
 * Triggers still come from Klaviyo events (free plan): only the sending moves.
 */
import {
  CHECKOUT_STARTED, PLACED_ORDER, STEPS as RELAY_STEPS, WHEEL_WON, emptyRelayState, selectDue,
  type RelayState, type RelayStep, type TriggerEvent,
} from "../flow-relay";
import { MODE_KEY, configProblems, loadEngineConfig, parseMode, type EngineMode, type OutgoingEmail, type SendOutcome } from "./engine";
import { mayEmail, type KlaviyoConsent } from "./consent";
import { avis, baissePrix, bienvenue1, bienvenue2, relance1, relance2, roue1, roue2, roue3, type EmailContent, type Props, eventLocale } from "./templates";

export const STATE_KEY = "email_flows_state";
export const TEST_STATE_KEY = "email_flows_state_test";
export const TAKEOVER_KEY = "email_engine_takeover";
/** Key of relance-paiement.ts in the relay world (it is not a flow-relay STEP). */
export const RELANCE_PAIEMENT_RELAY = "relance-paiement";

export type FlowGroup = "relance" | "bienvenue" | "roue" | "avis" | "baisse-prix";
export const GROUPS: FlowGroup[] = ["relance", "bienvenue", "roue", "avis", "baisse-prix"];

/**
 * Consent basis (CASL): "express" = the person ticked a marketing box (Klaviyo email consent
 * SUBSCRIBED); "own" = the trigger itself proves it (the wheel only fires with consent ticked, a
 * price alert is a request, a purchase is an existing business relationship).
 */
export type ConsentBasis = "express" | "own";

export interface EngineFlow {
  key: string;
  group: FlowGroup;
  /** The relay step this replaces. */
  relayKey: string;
  step: RelayStep;
  consent: ConsentBasis;
  render: (props: Props) => EmailContent | null;
}

/** Engine bookkeeping: the relay shape plus, per step, the events whose email really went out. */
export interface EngineState extends RelayState {
  sent: Record<string, Record<string, string>>;
}

/** Same timing as the relay step. A renamed relay step drops the flow (logged) instead of breaking the relays at import. */
function relayStep(key: string, over: Partial<RelayStep> = {}): RelayStep | null {
  const s = RELAY_STEPS.find((x) => x.key === key);
  if (!s) console.error(`[email-flows] flow-relay step "${key}" not found — flow disabled`);
  return s ? { ...s, ...over } : null;
}

const def = (f: Omit<EngineFlow, "step"> & { step: RelayStep | null }): EngineFlow[] => (f.step ? [f as EngineFlow] : []);

export const FLOWS: EngineFlow[] = [
  // relance-paiement.ts: 30 min after the checkout, up to 36 h, one per profile per 72 h
  ...def({ key: "relance-1", group: "relance", relayKey: RELANCE_PAIEMENT_RELAY, consent: "express", render: relance1,
    step: { key: "relance-1", flowId: "Xw6R8f", metricId: CHECKOUT_STARTED, offsetMin: 30, graceMin: 36 * 60 - 30, templateId: "", subject: "", preview: "", noOrderSinceTrigger: true, cooldownH: 72 } }),
  ...def({ key: "relance-2", group: "relance", relayKey: "checkout-2", consent: "express", render: relance2, step: relayStep("checkout-2", { key: "relance-2" }) }),
  ...def({ key: "bienvenue-1", group: "bienvenue", relayKey: "welcome-1", consent: "express", render: bienvenue1, step: relayStep("welcome-1", { key: "bienvenue-1" }) }),
  ...def({ key: "bienvenue-2", group: "bienvenue", relayKey: "welcome-2", consent: "express", render: bienvenue2, step: relayStep("welcome-2", { key: "bienvenue-2" }) }),
  ...def({ key: "roue-1", group: "roue", relayKey: "roue-1", consent: "own", render: roue1, step: relayStep("roue-1") }),
  ...def({ key: "roue-2", group: "roue", relayKey: "roue-2", consent: "own", render: roue2, step: relayStep("roue-2") }),
  ...def({ key: "roue-3", group: "roue", relayKey: "roue-3", consent: "own", render: roue3, step: relayStep("roue-3") }),
  ...def({ key: "avis", group: "avis", relayKey: "review", consent: "own", render: avis, step: relayStep("review", { key: "avis" }) }),
  ...def({ key: "baisse-prix", group: "baisse-prix", relayKey: "price-drop", consent: "own", render: baissePrix, step: relayStep("price-drop", { key: "baisse-prix" }) }),
];

// ─── state (pure) ──────────────────────────────────────────────────────

export function emptyEngineState(startAt: string): EngineState {
  return { ...emptyRelayState(), startAt, sent: {} };
}

export function parseEngineState(raw: string | null): EngineState | null {
  try {
    const o = JSON.parse(raw ?? "null") as Partial<EngineState> | null;
    if (!o || typeof o.startAt !== "string") return null;
    return { ...emptyEngineState(o.startAt), ...o, done: o.done ?? {}, prof: o.prof ?? {}, sent: o.sent ?? {} };
  } catch {
    return null;
  }
}

/** Forget what can no longer matter: events after 15 days, a profile once ITS flow's cooldown is over. */
export function pruneEngineState(s: EngineState, now: Date): EngineState {
  const t = now.getTime();
  const keep = (m: Record<string, Record<string, string>>, ms: (step: string) => number) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([, at]) => t - Date.parse(at) < ms(k)))]));
  const days15 = () => 15 * 24 * 3600e3;
  const cooldown = (k: string) => (FLOWS.find((f) => f.step.key === k)?.step.cooldownH ?? 0) * 3600e3;
  return { ...s, done: keep(s.done, days15), sent: keep(s.sent ?? {}, days15), prof: keep(s.prof, cooldown), pending: [], failures: [] };
}

// ─── the relays' side (pure) ───────────────────────────────────────────

const merge = (a: Record<string, string> | undefined, b: Record<string, string> | undefined) => ({ ...(a ?? {}), ...(b ?? {}) });

/** flow-relay state + what the engine handled for the same steps (events done, profile cooldowns). */
export function mergeEngineIntoRelay(relay: RelayState, engine: EngineState | null): RelayState {
  if (!engine) return relay;
  const done = { ...relay.done }, prof = { ...relay.prof };
  for (const f of FLOWS) {
    if (f.relayKey === RELANCE_PAIEMENT_RELAY) continue;
    if (engine.done[f.step.key]) done[f.relayKey] = merge(done[f.relayKey], engine.done[f.step.key]);
    if (engine.prof[f.step.key]) prof[f.relayKey] = merge(prof[f.relayKey], engine.prof[f.step.key]);
  }
  return { ...relay, done, prof };
}

export interface RelanceLike { events?: Record<string, string>; sent?: Record<string, string>; profiles?: Record<string, string> }

/** relance-paiement state + the engine's reminder #1 (handled, really sent, cooldowns). */
export function mergeEngineIntoRelance<T extends RelanceLike>(relance: T, engine: EngineState | null): T {
  if (!engine) return relance;
  return {
    ...relance,
    events: merge(relance.events, engine.done["relance-1"]),
    sent: merge(relance.sent, engine.sent?.["relance-1"]),
    profiles: merge(relance.profiles, engine.prof["relance-1"]),
  };
}

// ─── hand-over switches (pure) ─────────────────────────────────────────

export type Takeover = Partial<Record<FlowGroup, string>>;

export function parseTakeover(raw: string | null): Takeover {
  try {
    const o = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    const out: Takeover = {};
    for (const g of GROUPS) if (typeof o[g] === "string" && !Number.isNaN(Date.parse(o[g] as string))) out[g] = o[g] as string;
    return out;
  } catch {
    return {};
  }
}

/** Relay step keys the relays must skip: only while the engine is LIVE for that group and able to send. */
export function relayKeysOwnedByEngine(mode: EngineMode, takeover: Takeover, configOk = true): Set<string> {
  if (mode !== "live" || !configOk) return new Set();
  return new Set(FLOWS.filter((f) => takeover[f.group]).map((f) => f.relayKey));
}

/**
 * What the relays call at the start of each run. A settings read error THROWS (the relay run
 * aborts and retries in 15 min) rather than guessing "nothing owned" and resending.
 */
export async function loadRelayKeysOwnedByEngine(getSetting: (k: string) => Promise<string | null>): Promise<Set<string>> {
  const [mode, takeover] = await Promise.all([getSetting(MODE_KEY), getSetting(TAKEOVER_KEY)]);
  const m = parseMode(mode);
  if (m !== "live") return new Set();
  const configOk = configProblems(await loadEngineConfig(getSetting)).length === 0;
  return relayKeysOwnedByEngine(m, parseTakeover(takeover), configOk);
}

/** The engine's live bookkeeping, for the relays (null when none or unreadable: the relays then see only their own). */
export async function loadEngineStateForRelays(getSetting: (k: string) => Promise<string | null>): Promise<EngineState | null> {
  return parseEngineState(await getSetting(STATE_KEY));
}

/** Groups this engine run handles. */
export function activeGroups(mode: EngineMode, takeover: Takeover): FlowGroup[] {
  if (mode === "off") return [];
  if (mode === "test") return GROUPS;
  return GROUPS.filter((g) => takeover[g]);
}

/** Overlap window before the hand-over: steps due then may not have been relayed yet. */
export const TAKEOVER_OVERLAP_MIN = 60;

export function groupStart(mode: EngineMode, takeover: Takeover, group: FlowGroup, stateStart: string): string {
  const t = takeover[group];
  if (mode !== "live" || !t) return stateStart;
  const s = new Date(Date.parse(t) - TAKEOVER_OVERLAP_MIN * 60e3).toISOString();
  return s > stateStart ? s : stateStart;
}

export const idemKey = (flow: EngineFlow, ev: TriggerEvent) => `${flow.key}:${ev.id}`;

// ─── one run ───────────────────────────────────────────────────────────

/** The relays' bookkeeping as the engine sees it, keyed by relay step (relance-paiement under RELANCE_PAIEMENT_RELAY). */
export interface RelayView {
  done: Record<string, Record<string, string>>;
  prof: Record<string, Record<string, string>>;
}

export function relayView(relay: RelayState | null, relance: RelanceLike | null): RelayView {
  return {
    done: { ...(relay?.done ?? {}), [RELANCE_PAIEMENT_RELAY]: relance?.events ?? {} },
    prof: { ...(relay?.prof ?? {}), [RELANCE_PAIEMENT_RELAY]: relance?.profiles ?? {} },
  };
}

export interface FlowRunDeps {
  now: Date;
  mode: EngineMode;
  takeover: Takeover;
  loadState: () => Promise<EngineState | null>;
  saveState: (s: EngineState) => Promise<void>;
  events: (metricId: string, sinceIso: string) => Promise<TriggerEvent[]>;
  /** What the relays handled (skipped here) and their per-profile cooldowns (honoured here). */
  relay: RelayView;
  /** Did the abandoned-checkout reminder #1 for this checkout go out (engine or relay)? */
  relance1Sent: (eventId: string) => Promise<boolean>;
  /** Klaviyo's own flow delivers again → stop (the person would get both). */
  flowSendingAgain: (flowId: string) => boolean;
  /** Klaviyo consent of the profile (see consent.ts). Throwing = unknown → retried next run. */
  consentOf: (profileId: string) => Promise<KlaviyoConsent>;
  /** Mode "test": only the test recipients. */
  recipientAllowed: (email: string) => boolean;
  send: (msg: OutgoingEmail) => Promise<SendOutcome>;
  timeLeft: () => boolean;
}

export interface FlowRunResult {
  groups: FlowGroup[];
  sent: Record<string, number>;
  skipped: Record<string, number>;
  failed: Array<{ flow: string; error: string }>;
  postponed: string[];
  due?: Record<string, number>;
}

export const MAX_PER_FLOW = 60;

export async function runEmailFlows(d: FlowRunDeps, opts: { dryRun?: boolean } = {}): Promise<FlowRunResult> {
  const groups = activeGroups(d.mode, d.takeover);
  const res: FlowRunResult = { groups, sent: {}, skipped: {}, failed: [], postponed: [] };
  if (!groups.length) return res;
  const now = d.now;
  const iso = (min: number) => new Date(now.getTime() - min * 60e3).toISOString().slice(0, 19);
  // first run: the overlap window only (older triggers were the relays' job), never the whole history
  let state = (await d.loadState()) ?? emptyEngineState(new Date(now.getTime() - TAKEOVER_OVERLAP_MIN * 60e3).toISOString());
  state = pruneEngineState(state, now);
  const flows = FLOWS.filter((f) => groups.includes(f.group));

  const byMetric = new Map<string, TriggerEvent[]>();
  for (const m of new Set(flows.map((f) => f.step.metricId))) {
    const lookback = Math.max(...flows.filter((f) => f.step.metricId === m).map((f) => f.step.offsetMin + f.step.graceMin)) + 60;
    byMetric.set(m, await d.events(m, iso(lookback)));
  }
  const maxLookback = Math.max(...flows.map((f) => f.step.offsetMin + f.step.graceMin)) + 60;
  const orderTimes = new Map<string, number[]>();
  for (const o of await d.events(PLACED_ORDER, iso(maxLookback))) orderTimes.set(o.profileId, [...(orderTimes.get(o.profileId) ?? []), Date.parse(o.at)]);
  const wheel = flows.some((f) => f.step.noRecentWheelWin) ? await d.events(WHEEL_WON, iso(7 * 24 * 60)) : [];

  // relance-2 needs reminder #1 sent: resolved up front (async) for selectDue (sync)
  const r1 = new Set<string>();
  if (flows.some((f) => f.step.requiresRelancePaiement)) {
    for (const e of byMetric.get(CHECKOUT_STARTED) ?? []) if (await d.relance1Sent(e.id)) r1.add(e.id);
  }

  const consentCache = new Map<string, KlaviyoConsent | null>();
  const consent = async (pid: string) => {
    if (!consentCache.has(pid)) consentCache.set(pid, await d.consentOf(pid).catch(() => null));
    return consentCache.get(pid)!;
  };
  const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
  if (opts.dryRun) res.due = {};

  for (const flow of flows) {
    if (!d.timeLeft()) { res.postponed.push(flow.key); continue; }
    const k = flow.step.key;
    const ctx = {
      now,
      // the relays' cooldowns count too: someone they just mailed is not mailed again here
      state: { ...state, startAt: groupStart(d.mode, d.takeover, flow.group, state.startAt), prof: { ...state.prof, [k]: merge(d.relay.prof[flow.relayKey], state.prof[k]) } },
      orderedAfter: (pid: string, at: string) => (orderTimes.get(pid) ?? []).some((t) => t >= Date.parse(at) - 5 * 60e3),
      wonWheelWithin7d: (pid: string) => wheel.some((w) => w.profileId === pid && now.getTime() - Date.parse(w.at) < 7 * 24 * 3600e3),
      relancePaiementSent: (id: string) => r1.has(id),
      flowSendingAgain: d.flowSendingAgain,
    };
    const due = selectDue(flow.step, byMetric.get(flow.step.metricId) ?? [], ctx).filter((e) => !d.relay.done[flow.relayKey]?.[e.id]).slice(0, MAX_PER_FLOW);
    if (res.due) { res.due[flow.key] = due.length; continue; }

    for (const ev of due) {
      const at = now.toISOString();
      const mark = () => { state.done[k] = { ...(state.done[k] ?? {}), [ev.id]: at }; };
      // test mode: people outside the test list are the relays' job; no Klaviyo lookups for them
      if (!d.recipientAllowed(ev.email!)) { mark(); bump(res.skipped, `${flow.key}:hors-liste-test`); continue; }
      const c = await consent(ev.profileId);
      if (!c) { bump(res.skipped, `${flow.key}:consentement-inconnu`); continue; } // Klaviyo hiccup: retried next run
      if (!mayEmail(c, flow.consent)) { mark(); bump(res.skipped, `${flow.key}:sans-consentement`); continue; }
      const content = flow.render(ev.props);
      if (!content) { mark(); bump(res.skipped, `${flow.key}:donnees-incompletes`); continue; }
      const out = await d.send({ to: ev.email!, flow: flow.key, idemKey: idemKey(flow, ev), kind: "marketing", locale: eventLocale(ev.props), ...content });
      if (out.status === "failed" && out.retryable) { res.failed.push({ flow: flow.key, error: out.error }); continue; } // retried next run
      // engine switched off or misconfigured mid-run: not this person's fault, try again next run
      if (out.status === "skipped" && (out.reason === "off" || out.reason === "not-configured")) { bump(res.skipped, `${flow.key}:${out.reason}`); continue; }
      mark();
      if (out.status === "sent") {
        bump(res.sent, flow.key);
        state.prof[k] = { ...(state.prof[k] ?? {}), [ev.profileId]: at };
        state.sent[k] = { ...(state.sent[k] ?? {}), [ev.id]: at };
      } else if (out.status === "failed") {
        res.failed.push({ flow: flow.key, error: out.error });
      } else {
        bump(res.skipped, `${flow.key}:${out.reason}`);
        continue;
      }
      // saved after each email: a timeout later must not resend it (email_sends also blocks it)
      await d.saveState(state);
    }
  }
  if (!opts.dryRun) await d.saveState(state);
  return res;
}
