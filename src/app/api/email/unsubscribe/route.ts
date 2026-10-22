/**
 * /api/email/unsubscribe?e=…&t=… — the signed link in every email footer (src/lib/email/unsubscribe.ts).
 *
 * GET only shows a confirmation button: corporate link scanners (Outlook Safe Links…) open every
 * link, so a GET must never unsubscribe anyone. POST unsubscribes: the button's form, and the
 * one-click `List-Unsubscribe-Post` (RFC 8058) that Gmail and Yahoo send from their own
 * "Unsubscribe" button. CASL: the request is honoured at once (the law allows up to 10 business days).
 */
import { NextResponse } from "next/server";
import { markSuppressionInKlaviyo, suppressEmail } from "@/lib/database";
import { checkRateLimit } from "@/lib/rate-limiter";
import { clientIp } from "@/lib/client-ip";
import { esc } from "@/lib/email/layout";
import { suppressInKlaviyo } from "@/lib/email/consent";
import { acceptedSecrets, verifyUnsubscribe } from "@/lib/email/unsubscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COPY = {
  confirm: {
    title: "Se désabonner · Unsubscribe",
    fr: (email: string) => `Ne plus recevoir nos courriels promotionnels à <b>${esc(email)}</b> ?`,
    en: (email: string) => `Stop receiving our promotional emails at <b>${esc(email)}</b>?`,
    button: "Me désabonner · Unsubscribe me",
  },
  done: {
    title: "C’est fait · Done",
    fr: "Tu ne recevras plus nos courriels promotionnels. Les courriels liés à une commande (confirmation, livraison) continuent.",
    en: "You will no longer receive our promotional emails. Order emails (confirmation, shipping) still go out.",
  },
  invalid: {
    title: "Lien invalide · Invalid link",
    fr: "Ce lien de désabonnement est incomplet. Réponds simplement à un de nos courriels avec « désabonner » et on s’en occupe.",
    en: "This unsubscribe link is incomplete. Just reply to one of our emails with “unsubscribe” and we will take care of it.",
  },
};

function page(status: number, title: string, inner: string): NextResponse {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f4f1ec;font:16px/1.5 Arial,sans-serif;color:#222">
<main style="max-width:480px;margin:48px auto;padding:28px 24px;background:#fff;border-radius:10px">
<p style="font-weight:bold;font-size:20px;margin:0 0 16px">Ameublo Direct</p>${inner}</main></body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

function verify(request: Request): string | null {
  const u = new URL(request.url);
  for (const secret of acceptedSecrets()) {
    const email = verifyUnsubscribe(u.searchParams.get("e"), u.searchParams.get("t"), secret);
    if (email) return email;
  }
  return null;
}

const invalid = () => page(400, COPY.invalid.title, `<p>${COPY.invalid.fr}</p><p style="color:#666">${COPY.invalid.en}</p>`);

export async function GET(request: Request) {
  const email = verify(request);
  if (!email) return invalid();
  const c = COPY.confirm;
  // Same URL (query string kept): the POST re-verifies the token.
  return page(200, c.title, `<p>${c.fr(email)}</p><p style="color:#666">${c.en(email)}</p>
<form method="post"><button type="submit" style="margin-top:12px;width:100%;min-height:48px;border:0;border-radius:6px;background:#c8553d;color:#fff;font:bold 16px Arial,sans-serif;cursor:pointer">${c.button}</button></form>`);
}

export async function POST(request: Request) {
  if (!checkRateLimit(`unsub:${clientIp(request)}`, 30, 60_000).allowed) return new NextResponse("Too many requests", { status: 429 });
  const email = verify(request);
  if (!email) return invalid();
  const oneClick = /List-Unsubscribe=One-Click/i.test(await request.text().catch(() => ""));
  await suppressEmail({ email, reason: "unsubscribe", source: oneClick ? "one-click" : "link" });
  // Klaviyo still sends the relay emails during the hand-over: unsubscribe there too. On failure the
  // /api/cron/email-flows run retries it (email_suppressions.in_klaviyo stays 0).
  if (process.env.KLAVIYO_API_KEY) {
    await suppressInKlaviyo(email).then(() => markSuppressionInKlaviyo(email)).catch((err) => console.warn(`[unsubscribe] Klaviyo suppression failed, retried by cron: ${err}`));
  }
  if (oneClick) return new NextResponse(null, { status: 200 });
  return page(200, COPY.done.title, `<p>${COPY.done.fr}</p><p style="color:#666">${COPY.done.en}</p>`);
}
