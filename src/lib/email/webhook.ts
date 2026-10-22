/**
 * Resend webhooks (signed with Svix): bounces and spam complaints feed our suppression list, so an
 * address that bounced or complained is never mailed again (deliverability + CASL).
 * Secret: RESEND_WEBHOOK_SECRET ("whsec_…", shown when the webhook is created in Resend).
 */
import crypto from "node:crypto";

export const WEBHOOK_TOLERANCE_S = 5 * 60;

/** Svix scheme: base64 HMAC-SHA256 of `${id}.${timestamp}.${body}` with the base64 key after `whsec_`. */
export function verifySvix(
  body: string,
  h: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!h.id || !h.timestamp || !h.signature || !secret.startsWith("whsec_")) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_S) return false;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const want = Buffer.from(crypto.createHmac("sha256", key).update(`${h.id}.${h.timestamp}.${body}`).digest("base64"));
  return h.signature.split(" ").some((part) => {
    const [ver, sig] = part.split(",");
    if (ver !== "v1" || !sig) return false;
    const got = Buffer.from(sig);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
}

export interface WebhookEvent {
  type: string;
  created_at?: string;
  data?: { email_id?: string; to?: string[] | string; bounce?: { type?: string; subType?: string; message?: string } };
}

export const TRACKED_STATUSES = ["delivered", "bounced", "complained", "opened", "clicked", "failed", "delivery_delayed"] as const;

export interface WebhookAction {
  /** Addresses to never mail again (hard bounce, spam complaint). */
  suppress: { emails: string[]; reason: "bounce" | "complaint"; detail: string } | null;
  /** Latest delivery status for the email_sends row with this Resend id. */
  status: { resendId: string; status: string } | null;
}

/** What a webhook event means for us. Temporary bounces (mailbox full…) do not suppress. */
export function webhookAction(ev: WebhookEvent): WebhookAction {
  const to = ev.data?.to;
  const emails = (Array.isArray(to) ? to : to ? [to] : []).filter((x) => typeof x === "string");
  let suppress: WebhookAction["suppress"] = null;
  if (ev.type === "email.complained" && emails.length) suppress = { emails, reason: "complaint", detail: "spam complaint" };
  if (ev.type === "email.bounced" && emails.length) {
    const b = ev.data?.bounce;
    if (!/transient|temporary/i.test(b?.type ?? "")) suppress = { emails, reason: "bounce", detail: `${b?.type ?? "?"}/${b?.subType ?? "?"}`.slice(0, 200) };
  }
  const s = ev.type.startsWith("email.") ? ev.type.slice(6) : "";
  const status = ev.data?.email_id && (TRACKED_STATUSES as readonly string[]).includes(s) ? { resendId: ev.data.email_id, status: s } : null;
  return { suppress, status };
}
