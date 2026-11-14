/**
 * Own email engine — sends one email through Resend after every safety check.
 *
 * WHY: Klaviyo bills by active profile and its flows never sent on this account (see flow-relay.ts).
 * The flows (who gets what, when) stay in our code; this module is the single exit door, so every
 * email gets the same guarantees:
 *   - master switch: settings `email_engine_mode` = "off" (default) | "test" | "live".
 *     "test" only mails the addresses in `email_test_recipients` (comma-separated);
 *   - never to a suppressed address (unsubscribed, hard bounce, spam complaint);
 *   - never twice: `idemKey` is claimed in email_sends before calling Resend, and Resend gets
 *     the same key (it drops a repeat within 24 h even if our DB write failed);
 *   - CASL footer (sender, mailing address `email_mailing_address`, unsubscribe link) and the
 *     one-click List-Unsubscribe headers Gmail and Yahoo require from bulk senders.
 * Nothing is sent while a piece of configuration is missing: `configProblems` names it.
 */
import { getPublicAppUrl } from "@/lib/config";
import { renderLayout, type Locale } from "./layout";
import { sendViaResend, type ResendEmail, type ResendResult } from "./resend";
import { emailKey, tokenSecret, unsubscribeUrl } from "./unsubscribe";

export const MODE_KEY = "email_engine_mode";
export const TEST_RECIPIENTS_KEY = "email_test_recipients";
export const ADDRESS_KEY = "email_mailing_address";

export type EngineMode = "off" | "test" | "live";

export interface OutgoingEmail {
  to: string;
  /** Flow step, e.g. "relance-1". Also the Resend tag and the dashboard grouping. */
  flow: string;
  /** Unique per real-world email: `${flow}:${trigger id}`. The same key is never sent twice. */
  idemKey: string;
  /** "marketing" respects unsubscribes; "transactional" (order-related, CASL-exempt) does not. */
  kind: "marketing" | "transactional";
  locale: Locale;
  subject: string;
  preheader: string;
  bodyHtml: string;
  bodyText: string;
}

export interface EngineConfig {
  mode: EngineMode;
  testRecipients: Set<string>;
  mailingAddress: string;
  from: string;
  replyTo: string;
  apiKey: string;
  tokenSecret: string;
  baseUrl: string;
}

export type SkipReason = "off" | "not-test-recipient" | "invalid-email" | "suppressed" | "duplicate" | "not-configured";
export type SendOutcome =
  | { status: "sent"; id: string }
  | { status: "skipped"; reason: SkipReason; detail?: string }
  | { status: "failed"; error: string; retryable: boolean };

export function parseMode(v: string | null): EngineMode {
  return v === "test" || v === "live" ? v : "off";
}

export function parseRecipients(v: string | null): Set<string> {
  return new Set((v ?? "").split(/[,;\s]+/).map(emailKey).filter((x) => x.includes("@")));
}

export async function loadEngineConfig(
  getSetting: (k: string) => Promise<string | null>,
  env: Record<string, string | undefined> = process.env,
): Promise<EngineConfig> {
  const [mode, test, address] = await Promise.all([getSetting(MODE_KEY), getSetting(TEST_RECIPIENTS_KEY), getSetting(ADDRESS_KEY)]);
  return {
    mode: parseMode(mode),
    testRecipients: parseRecipients(test),
    mailingAddress: (address ?? "").trim(),
    from: (env.EMAIL_FROM ?? "").trim(),
    replyTo: (env.EMAIL_REPLY_TO ?? "").trim(),
    apiKey: (env.RESEND_API_KEY ?? "").trim(),
    tokenSecret: tokenSecret(env) ?? "",
    baseUrl: getPublicAppUrl() ?? "",
  };
}

/** Missing pieces, in plain words for the dashboard. Empty = ready to send. */
export function configProblems(c: EngineConfig): string[] {
  const p: string[] = [];
  if (!c.apiKey) p.push("RESEND_API_KEY manquante");
  if (!/^[^<>]*<[^\s@<>]+@[^\s@<>]+>$|^[^\s@<>]+@[^\s@<>]+$/.test(c.from)) p.push("EMAIL_FROM manquant ou invalide (ex. « Ameublo Direct <bonjour@ameublodirect.ca> »)");
  if (!c.tokenSecret) p.push("EMAIL_TOKEN_SECRET manquant (32 caractères minimum)");
  if (!c.baseUrl) p.push("URL publique de l’app inconnue (NEXT_PUBLIC_APP_URL)");
  if (c.mailingAddress.length < 10) p.push("adresse postale manquante (réglage email_mailing_address, exigée par la loi anti-pourriel)");
  return p;
}

export interface EngineDeps {
  isSuppressed: (email: string) => Promise<boolean>;
  reserve: (s: { idemKey: string; email: string; flow: string; kind: string }) => Promise<number | null>;
  finish: (id: number, r: { status: "sent" | "failed" | "skipped"; resendId?: string | null; error?: string | null }) => Promise<void>;
  send: (e: ResendEmail, idemKey: string) => Promise<ResendResult>;
}

/** The exact email that would go out (also used for previews). */
export function buildEmail(msg: OutgoingEmail, c: Pick<EngineConfig, "from" | "replyTo" | "mailingAddress" | "tokenSecret" | "baseUrl">): ResendEmail {
  const unsub = unsubscribeUrl(c.baseUrl, msg.to, c.tokenSecret);
  const { html, text } = renderLayout({ locale: msg.locale, preheader: msg.preheader, bodyHtml: msg.bodyHtml, bodyText: msg.bodyText, mailingAddress: c.mailingAddress, unsubscribeUrl: unsub });
  return {
    from: c.from,
    to: msg.to.trim(),
    subject: msg.subject,
    html,
    text,
    replyTo: c.replyTo || undefined,
    headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    tags: { flow: msg.flow, kind: msg.kind },
  };
}

export async function sendEmail(msg: OutgoingEmail, c: EngineConfig, deps: EngineDeps): Promise<SendOutcome> {
  const to = emailKey(msg.to);
  if (c.mode === "off") return { status: "skipped", reason: "off" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to) || to.length > 254) return { status: "skipped", reason: "invalid-email" };
  if (c.mode === "test" && !c.testRecipients.has(to)) return { status: "skipped", reason: "not-test-recipient" };
  const problems = configProblems(c);
  if (problems.length) return { status: "skipped", reason: "not-configured", detail: problems.join(" · ") };
  if (msg.kind === "marketing" && (await deps.isSuppressed(to))) return { status: "skipped", reason: "suppressed" };

  const id = await deps.reserve({ idemKey: msg.idemKey, email: to, flow: msg.flow, kind: msg.kind });
  if (id == null) return { status: "skipped", reason: "duplicate" };
  let r: ResendResult;
  try {
    r = await deps.send(buildEmail(msg, c), msg.idemKey);
  } catch (err) {
    r = { ok: false, status: 0, error: err instanceof Error ? err.message : String(err), retryable: true };
  }
  if (r.ok) {
    await deps.finish(id, { status: "sent", resendId: r.id });
    return { status: "sent", id: r.id };
  }
  await deps.finish(id, { status: "failed", error: r.error });
  return { status: "failed", error: r.error, retryable: r.retryable };
}

/** Production wiring: real DB + Resend. */
export async function defaultEngineDeps(apiKey: string): Promise<EngineDeps> {
  const db = await import("@/lib/database");
  return {
    isSuppressed: db.isEmailSuppressed,
    reserve: db.reserveEmailSend,
    finish: db.finishEmailSend,
    send: (e, key) => sendViaResend(e, key, { apiKey }),
  };
}
