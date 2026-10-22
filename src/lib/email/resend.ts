/**
 * Resend HTTP client (https://resend.com/docs/api-reference/emails/send-email) — plain fetch, no SDK.
 *
 * Only the transport: who may receive what is decided in engine.ts. Every call carries an
 * Idempotency-Key, so a retry after a timeout cannot deliver the same email twice (Resend keeps
 * the key 24 h).
 */

export const RESEND_API = "https://api.resend.com";

export interface ResendEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** Resend tags: ASCII letters, digits, `_` and `-` only. */
  tags?: Record<string, string>;
}

export type ResendResult = { ok: true; id: string } | { ok: false; status: number; error: string; retryable: boolean };

const TAG_SAFE = /[^A-Za-z0-9_-]/g;

export function toResendBody(e: ResendEmail): Record<string, unknown> {
  const body: Record<string, unknown> = { from: e.from, to: [e.to], subject: e.subject, html: e.html, text: e.text };
  if (e.replyTo) body.reply_to = e.replyTo;
  if (e.headers && Object.keys(e.headers).length) body.headers = e.headers;
  if (e.tags) body.tags = Object.entries(e.tags).map(([name, value]) => ({ name: name.replace(TAG_SAFE, "_"), value: value.replace(TAG_SAFE, "_").slice(0, 256) }));
  return body;
}

export async function sendViaResend(
  e: ResendEmail,
  idempotencyKey: string,
  opts: { apiKey: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> },
): Promise<ResendResult> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await f(`${RESEND_API}/emails`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.slice(0, 256) },
        body: JSON.stringify(toResendBody(e)),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err), retryable: true };
    }
    // One polite retry on rate limit; the idempotency key makes it safe.
    if (res.status === 429 && attempt === 0) {
      await sleep(Math.min(Number(res.headers.get("retry-after")) || 1, 10) * 1000);
      continue;
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (res.ok && json.id) return { ok: true, id: json.id };
    return { ok: false, status: res.status, error: `${json.name ?? "error"}: ${json.message ?? res.statusText}`.slice(0, 500), retryable: res.status === 429 || res.status >= 500 };
  }
}
