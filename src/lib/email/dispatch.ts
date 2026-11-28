/**
 * The one switch for event-driven emails (free email, 2026-11-27).
 *
 * Every place that used to fire a Klaviyo event so a Klaviyo flow would send an email (morning report, publication
 * alert, price-alert and back-in-stock confirmations and alerts, referral credit) calls `dispatchEvent` instead of
 * `trackEvent`, with the same arguments. What happens depends on settings `email_provider` (engine.ts):
 *   - "klaviyo" (default): exactly as before — the Klaviyo event, nothing else;
 *   - "test": the Klaviyo event as before, PLUS the Resend version for the test addresses only (to compare);
 *   - "resend": no Klaviyo call at all (no new Klaviyo profile either); the email is rendered by direct.ts and sent
 *     by the engine. Resend's daily cap reached, or a Resend hiccup → the email waits in `email_outbox` and the
 *     email-flows cron sends it as soon as there is room (outbox.ts). Never twice: same idem key everywhere.
 * A provider other than "klaviyo" with a configuration problem behaves as "klaviyo" (customers keep getting mail).
 *
 * The result keeps trackEvent's shape: `ok` = accepted (sent, queued, or deliberately not sent such as an
 * unsubscribed address), so callers that "mark notified when ok" stay correct.
 */
import crypto from "node:crypto";
import { configProblems, loadEngineConfig, type EngineConfig, type OutgoingEmail, type SendOutcome } from "./engine";
import { DIRECT, DIRECT_FLOW } from "./direct";
import { emailKey } from "./unsubscribe";

export type Route = "klaviyo" | "test" | "resend";

/** Where emails really go now: the provider asked for, unless its configuration is incomplete. */
export function routeFor(cfg: Pick<EngineConfig, "provider"> & Parameters<typeof configProblems>[0]): Route {
  if (cfg.provider === "klaviyo") return "klaviyo";
  return configProblems(cfg).length ? "klaviyo" : cfg.provider;
}

/** The route right now, read from settings (forms use it to decide whether to write to Klaviyo at all). */
export async function currentRoute(getSetting?: (k: string) => Promise<string | null>): Promise<Route> {
  try {
    const g = getSetting ?? (await import("@/lib/database")).getSetting;
    return routeFor(await loadEngineConfig(g));
  } catch {
    return "klaviyo"; // settings unreadable: today's behaviour
  }
}

export interface DispatchResult {
  ok: boolean;
  via: "klaviyo" | "resend" | "queued" | "none";
  skipped?: boolean;
  error?: string;
}

export interface DispatchOptions {
  /** Unique per real-world email. Default: event + address + properties (a retry with the same data never resends). */
  idemKey?: string;
  /** Give up on a queued email after this many hours (default 72; a 24 h confirmation link → 20). */
  maxDelayH?: number;
}

export interface DispatchDeps {
  getSetting: (k: string) => Promise<string | null>;
  trackEvent: (metric: string, email: string, props: Record<string, unknown>) => Promise<{ ok: boolean; skipped?: boolean; error?: string }>;
  send: (msg: OutgoingEmail, cfg: EngineConfig) => Promise<SendOutcome>;
  enqueue: (e: { idemKey: string; priority: number; notBefore: number; expiresAt: number; payload: string }) => Promise<boolean>;
  now?: () => Date;
}

export function defaultIdemKey(event: string, email: string, props: Record<string, unknown>): string {
  const flow = DIRECT_FLOW[event] ?? "evenement";
  const h = crypto.createHash("sha256").update(`${event}\n${emailKey(email)}\n${JSON.stringify(props)}`).digest("hex").slice(0, 24);
  return `${flow}:${h}`;
}

/** The email the engine would send for this event, or null (unknown event, or data missing). */
export function directEmail(event: string, email: string, props: Record<string, unknown>, idemKey: string): OutgoingEmail | null {
  const render = DIRECT[event];
  const c = render?.(props);
  if (!c) return null;
  return { to: email, flow: DIRECT_FLOW[event] ?? "evenement", idemKey, kind: c.kind, priority: c.priority, locale: c.locale, subject: c.subject, preheader: c.preheader, bodyHtml: c.bodyHtml, bodyText: c.bodyText };
}

const klaviyo = async (d: DispatchDeps, event: string, email: string, props: Record<string, unknown>): Promise<DispatchResult> => {
  const r = await d.trackEvent(event, email, props);
  return { ok: r.ok, via: "klaviyo", ...(r.skipped ? { skipped: true } : {}), ...(r.error ? { error: r.error } : {}) };
};

export async function dispatchEvent(
  event: string,
  email: string,
  props: Record<string, unknown>,
  opts: DispatchOptions = {},
  deps?: DispatchDeps,
): Promise<DispatchResult> {
  const d = deps ?? (await defaultDispatchDeps());
  let cfg: EngineConfig;
  try {
    cfg = await loadEngineConfig(d.getSetting);
  } catch (err) {
    // settings unreadable: today's path (Klaviyo) rather than no email at all
    console.warn(`[email] ${event}: settings unreadable, sent through Klaviyo: ${err}`);
    return klaviyo(d, event, email, props);
  }
  const route = routeFor(cfg);
  const idemKey = opts.idemKey ?? defaultIdemKey(event, email, props);
  if (route === "klaviyo" || !DIRECT[event]) return klaviyo(d, event, email, props);

  if (route === "test") {
    const r = await klaviyo(d, event, email, props);
    // the Resend copy for the test addresses only (engine "test" mode skips everyone else); never blocks the real one
    if (cfg.testRecipients.has(emailKey(email))) {
      const msg = directEmail(event, email, props, `test:${idemKey}`);
      if (msg) await d.send(msg, cfg).catch((err) => console.warn(`[email] test copy of ${event} failed: ${err}`));
    }
    return r;
  }

  const msg = directEmail(event, email, props, idemKey);
  if (!msg) {
    console.warn(`[email] ${event}: data incomplete, no email (Resend)`);
    return { ok: true, via: "none", skipped: true, error: "données incomplètes" };
  }
  let out: SendOutcome;
  try {
    out = await d.send(msg, cfg);
  } catch (err) {
    out = { status: "failed", error: err instanceof Error ? err.message : String(err), retryable: true };
  }
  if (out.status === "sent") return { ok: true, via: "resend" };
  if (out.status === "skipped") {
    if (out.reason === "duplicate") return { ok: true, via: "resend" }; // already went out (or is going out)
    if (out.reason === "suppressed" || out.reason === "invalid-email" || out.reason === "not-test-recipient") {
      return { ok: true, via: "none", skipped: true, error: out.reason };
    }
    if (out.reason !== "daily-cap" && out.reason !== "monthly-cap") return { ok: false, via: "none", error: out.reason };
  }
  if (out.status === "failed" && !out.retryable) return { ok: false, via: "none", error: out.error };
  // cap reached, or a Resend hiccup: wait in the queue, the email-flows cron sends it when there is room
  const nowSec = Math.floor((d.now?.() ?? new Date()).getTime() / 1000);
  await d.enqueue({ idemKey, priority: msg.priority ?? 3, notBefore: nowSec, expiresAt: nowSec + (opts.maxDelayH ?? 72) * 3600, payload: JSON.stringify(msg) });
  return { ok: true, via: "queued" };
}

export async function defaultDispatchDeps(): Promise<DispatchDeps> {
  const db = await import("@/lib/database");
  const { trackEvent } = await import("@/lib/klaviyo-client");
  const { defaultEngineDeps, sendEmail } = await import("./engine");
  // lazy lookups: a module without one of these (tests, partial mocks) only fails on the path that needs it
  return {
    getSetting: (k) => db.getSetting(k),
    trackEvent: (m, e, p) => trackEvent(m, e, p),
    send: async (msg, cfg) => sendEmail(msg, cfg, await defaultEngineDeps(cfg.apiKey)),
    enqueue: (e) => db.enqueueEmail(e),
  };
}
