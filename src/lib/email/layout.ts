/**
 * Shared email shell: brand header, the caller's body, and the legal footer.
 *
 * CASL (Canada's anti-spam law) requires every commercial email to identify the sender with a
 * mailing address and to carry a working unsubscribe link. Both are built here, never by the
 * flows, so no flow can forget them. Colours follow the relance-paiement template.
 */

export type Locale = "fr" | "en";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const BRAND = { fr: "Ameublo Direct", en: "Furnish Direct" } as const;

const FOOTER = {
  fr: { unsub: "Se désabonner", why: "Tu reçois ce courriel parce que tu es client·e ou que tu t’es inscrit·e chez Ameublo Direct." },
  en: { unsub: "Unsubscribe", why: "You are receiving this email because you are a customer of, or signed up with, Furnish Direct." },
} as const;

export interface LayoutInput {
  locale: Locale;
  /** Inbox preview line (hidden in the body). */
  preheader: string;
  /** Inner HTML, already escaped by the caller. */
  bodyHtml: string;
  /** Plain-text version of the body (no footer: added here). */
  bodyText: string;
  mailingAddress: string;
  unsubscribeUrl: string;
}

export function renderLayout(i: LayoutInput): { html: string; text: string } {
  const f = FOOTER[i.locale];
  const brand = BRAND[i.locale];
  const html = `<!doctype html><html lang="${i.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"><title>${esc(brand)}</title></head>
<body style="margin:0;background:#f4f1ec">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(i.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px">
<tr><td style="padding:24px 24px 8px;font:bold 20px Arial,sans-serif;color:#222">${esc(brand)}</td></tr>
<tr><td style="padding:0 24px 24px;font:15px/1.5 Arial,sans-serif;color:#333">${i.bodyHtml}</td></tr>
</table>
<p style="font:12px/1.6 Arial,sans-serif;color:#777;max-width:560px;margin:16px auto 0">${esc(f.why)}<br>${esc(brand)} · ${esc(i.mailingAddress)}<br><a href="${esc(i.unsubscribeUrl)}" style="color:#777">${f.unsub}</a></p>
</td></tr></table></body></html>`;
  const text = `${i.bodyText.trim()}\n\n--\n${f.why}\n${brand} · ${i.mailingAddress}\n${f.unsub} : ${i.unsubscribeUrl}\n`;
  return { html, text };
}

/** A big tappable button (bulletproof table, works in Outlook). */
export function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px auto"><tr><td style="background:#c8553d;border-radius:6px"><a href="${esc(href)}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font:bold 16px Arial,sans-serif">${esc(label)}</a></td></tr></table>`;
}
