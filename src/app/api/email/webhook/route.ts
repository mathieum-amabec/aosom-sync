/**
 * POST /api/email/webhook — Resend delivery events (src/lib/email/webhook.ts).
 *
 * Signed with Svix (RESEND_WEBHOOK_SECRET); unsigned or stale calls get 401 and change nothing.
 * Hard bounces and spam complaints go to email_suppressions; every tracked event moves the
 * email_sends row forward (delivered → opened → clicked). Answers 200 quickly so Resend does not retry.
 */
import { NextResponse } from "next/server";
import { suppressEmail, updateEmailSendStatus } from "@/lib/database";
import { verifySvix, webhookAction, type WebhookEvent } from "@/lib/email/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 256 * 1024;

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? "";
  if (!secret) return NextResponse.json({ success: false, error: "not-configured" }, { status: 503 });
  const body = await request.text();
  if (body.length > MAX_BODY) return NextResponse.json({ success: false, error: "too-large" }, { status: 413 });
  const ok = verifySvix(body, {
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
  }, secret);
  if (!ok) return NextResponse.json({ success: false, error: "signature" }, { status: 401 });

  let ev: WebhookEvent;
  try {
    ev = JSON.parse(body) as WebhookEvent;
  } catch {
    return NextResponse.json({ success: false, error: "json" }, { status: 400 });
  }
  const a = webhookAction(ev);
  if (a.suppress) {
    for (const email of a.suppress.emails) await suppressEmail({ email, reason: a.suppress.reason, source: "resend-webhook", detail: a.suppress.detail });
  }
  if (a.status) await updateEmailSendStatus(a.status.resendId, a.status.status);
  return NextResponse.json({ success: true });
}
