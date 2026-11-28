/**
 * Emails that used to be a Klaviyo EVENT driving a Klaviyo flow (morning report, price-alert / back-in-stock
 * confirmations and alerts, referral credit), rendered by us when `email_provider` = "resend" (dispatch.ts).
 *
 * One renderer per event name, fed the SAME properties the Klaviyo event carried, so the call sites do not change.
 * A renderer returns null when the properties lack what the email needs: better no email than a broken one.
 * Copy follows the Klaviyo templates (docs/klaviyo/*.html). Links only to our own hosts (templates.ts `safeUrl`).
 */
import { getPublicAppUrl } from "@/lib/config";
import { button, esc, type Locale } from "./layout";
import type { Priority } from "./engine";
import { baissePrix, eventLocale, money, safeUrl, type EmailContent, type Props } from "./templates";

export interface DirectEmail extends EmailContent {
  /** "transactional" = asked for or internal (CASL-exempt); "marketing" respects unsubscribes. */
  kind: "marketing" | "transactional";
  priority: Priority;
  locale: Locale;
}

type Renderer = (props: Props) => DirectEmail | null;

const STORE_HOSTS = new Set(["ameublodirect.ca", "www.ameublodirect.ca", "furnishdirect.ca", "www.furnishdirect.ca"]);
const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const p = (html: string) => `<p style="margin:0 0 14px">${html}</p>`;
const h1 = (text: string) => `<h1 style="margin:8px 0 14px;font:bold 22px/1.3 Arial,sans-serif;color:#222">${esc(text)}</h1>`;
const small = (html: string) => `<p style="margin:0 0 14px;font-size:13px;color:#666">${html}</p>`;
const codeBox = (code: string) => `<p style="margin:16px 0;text-align:center"><span style="display:inline-block;padding:12px 22px;border:2px dashed #c8553d;border-radius:8px;font:bold 22px/1 'Courier New',monospace;letter-spacing:2px;color:#222">${esc(code)}</span></p>`;
const hr = `<hr style="border:0;border-top:1px solid #eee;margin:20px 0">`;
const langOf = (v: unknown): Locale => (str(v).toLowerCase().startsWith("en") ? "en" : "fr");

/** Confirmation links point at this app (outils.ameublodirect.ca), never anywhere else. */
function appUrl(v: unknown): string | null {
  const base = getPublicAppUrl();
  const hosts = new Set(["outils.ameublodirect.ca"]);
  if (base) hosts.add(new URL(base).hostname.toLowerCase());
  return safeUrl(v, hosts);
}

/** Internal emails to Mat (morning report, publication alert): body made by our own code. */
function internal(subject: string, bodyHtml: string, bodyText: string): DirectEmail {
  return { subject: subject.slice(0, 200), preheader: subject.slice(0, 120), bodyHtml, bodyText, kind: "transactional", priority: 0, locale: "fr" };
}

export const MORNING_REPORT_EVENT = "Rapport matinal";
export const PUBLISH_ALERT_EVENT = "Alerte publication";
export const PRICE_ALERT_CONFIRM_EVENT = "Price Alert Confirmation";
export const BACK_IN_STOCK_CONFIRM_EVENT = "Back In Stock Confirmation";
export const PRICE_DROP_EVENT = "Price Drop Alert";
export const BACK_IN_STOCK_EVENT = "Back In Stock";
/** Same name as src/lib/referral/credits.ts CREDIT_EVENT (not imported: that module pulls Shopify code). */
export const REFERRAL_CREDIT_EVENT = "Parrainage — crédit";
/** Courriel 1 of the referral launch (scripts/referral-launch.mts --via resend); never a Klaviyo event. */
export const REFERRAL_THANKS_EMAIL = "Parrainage — merci";

function confirmEmail(kind: "price" | "stock", props: Props): DirectEmail | null {
  const url = appUrl(props.confirm_url);
  if (!url) return null;
  const name = str(props.product_name, 150);
  const fr = kind === "price"
    ? { title: "Confirme ton alerte de prix 🔔", intro: `Tu as demandé à être averti·e quand le prix de <b>${esc(name || "ce produit")}</b> baissera. Clique sur le bouton pour activer l'alerte. Le lien est valide 24 h.`, cta: "Activer mon alerte" }
    : { title: "Confirme ton alerte de retour en stock 🔔", intro: `Tu as demandé à être averti·e quand <b>${esc(name || "ce produit")}</b> sera de retour en stock. Clique sur le bouton pour activer l'alerte. Le lien est valide 24 h.`, cta: "Activer mon alerte" };
  const en = kind === "price"
    ? { title: "Confirm your price alert 🔔", intro: `You asked to be notified when the price of <b>${esc(name || "this product")}</b> drops. Click the button to turn the alert on. The link is valid for 24 h.`, cta: "Turn on my alert" }
    : { title: "Confirm your back-in-stock alert 🔔", intro: `You asked to be notified when <b>${esc(name || "this product")}</b> is back in stock. Click the button to turn the alert on. The link is valid for 24 h.`, cta: "Turn on my alert" };
  const notYou = { fr: "Ce n'est pas toi? Ignore ce courriel : sans confirmation, tu ne recevras rien.", en: "Not you? Ignore this email: without confirmation you won't get anything." };
  const plain = (h: string) => h.replace(/<[^>]+>/g, "");
  return {
    subject: kind === "price" ? "Confirme ton alerte de prix 🔔 / Confirm your price alert" : "Confirme ton alerte de stock 🔔 / Confirm your stock alert",
    preheader: "Un clic pour l'activer. / One click to turn it on.",
    bodyHtml: h1(fr.title) + p(fr.intro) + button(url, fr.cta) + small(esc(notYou.fr)) + hr + h1(en.title) + p(en.intro) + button(url, en.cta) + small(esc(notYou.en)),
    bodyText: `${fr.title}\n\n${plain(fr.intro)}\n${fr.cta} : ${url}\n${notYou.fr}\n\n---\n\n${en.title}\n\n${plain(en.intro)}\n${en.cta}: ${url}\n${notYou.en}`,
    // the person asked for this email (double opt-in): transactional, and it must not wait behind marketing
    kind: "transactional",
    priority: 0,
    locale: "fr",
  };
}

function backInStock(props: Props): DirectEmail | null {
  const url = safeUrl(props.product_url, STORE_HOSTS);
  if (!url) return null;
  const name = str(props.title_fr ?? props.product_name, 150);
  const price = Number(props.price);
  const priceHtml = Number.isFinite(price) && price > 0 ? p(`<b>${money(price, "fr")}</b>`) : "";
  return {
    subject: "C'est de retour en stock ! 🎉",
    preheader: name ? `${name} est de nouveau disponible.` : "Un produit que tu attendais est de retour.",
    bodyHtml: h1("C'est de retour en stock 🎉") + p("Un produit que tu attendais est de nouveau disponible.") + (name ? p(`<b>${esc(name)}</b>`) : "") + priceHtml + button(url, "Voir le produit"),
    bodyText: `C'est de retour en stock\n\nUn produit que tu attendais est de nouveau disponible.\n${name}\n\nVoir le produit : ${url}`,
    kind: "marketing",
    priority: 3,
    locale: "fr",
  };
}

const CODE_RE = /^[A-Z0-9-]{4,40}$/;

function referralCredit(props: Props): DirectEmail | null {
  const code = str(props.code, 40).toUpperCase();
  if (!CODE_RE.test(code)) return null;
  const l = langOf(props.langue);
  const amount = Number(props.montant) || 10, min = Number(props.minimum) || 100, until = str(props.expire_le, 80);
  const shop = l === "en" ? "https://furnishdirect.ca" : "https://ameublodirect.ca";
  const c = l === "en"
    ? { subject: `Your friend placed an order: here is your $${amount}`, pre: "Thank you for telling people about us.", title: "Your friend placed an order", intro: `Someone you gave your code to just placed their first order with us. Thank you for telling people about us: for a small local business, it means a lot. As promised, here is $${amount} off your next purchase.`, label: "Your code", cta: "Shop now", terms: `$${amount} off an order of $${min} or more (before taxes). One use, cannot be combined with other discounts (free or discounted shipping still applies). Valid until ${until}. Referral rewards: up to 5 friends. This reward is cancelled if your friend's order is refunded before you use it.` }
    : { subject: `Votre ami a commandé : voici vos ${amount} $`, pre: "Merci d'avoir parlé de nous.", title: "Votre ami a commandé", intro: `Une personne à qui vous avez offert votre code vient de passer sa première commande chez nous. Merci d'avoir parlé de nous : pour une petite entreprise d'ici, ça compte beaucoup. Comme promis, voici ${amount} $ sur votre prochain achat.`, label: "Votre code", cta: "Magasiner", terms: `${amount} $ sur une commande de ${min} $ ou plus (avant taxes). 1 utilisation, non cumulable avec d'autres rabais (livraison incluse). Valide jusqu'au ${until}. Crédit parrain : jusqu'à 5 amis. Ce crédit est annulé si la commande de votre ami est remboursée avant que vous l'utilisiez.` };
  const url = `${shop}/discount/${encodeURIComponent(code)}`;
  return {
    subject: c.subject, preheader: c.pre,
    // Loi 25: never names the friend (the properties carry nothing about them)
    bodyHtml: h1(c.title) + p(esc(c.intro)) + small(`<b>${esc(c.label)}</b>`) + codeBox(code) + button(url, c.cta) + small(esc(c.terms)),
    bodyText: `${c.title}\n\n${c.intro}\n\n${c.label} : ${code}\n${c.cta} : ${url}\n\n${c.terms}`,
    // a reward the person earned: right after the wheel codes in priority, but still a commercial email (unsubscribe honoured)
    kind: "marketing",
    priority: 0,
    locale: l,
  };
}

function referralThanks(props: Props): DirectEmail | null {
  const code = str(props.code, 40).toUpperCase(), friend = str(props.code_ami, 40).toUpperCase();
  if (!CODE_RE.test(code) || !CODE_RE.test(friend)) return null;
  const l = langOf(props.langue);
  const until = str(props.code_expire, 80), friendUntil = str(props.code_ami_expire, 80);
  const shop = l === "en" ? "https://furnishdirect.ca" : "https://ameublodirect.ca";
  const c = l === "en"
    ? { subject: "A little thank-you from us: $10 for you", pre: "And $10 to give to someone you care about.", title: "Thank you for choosing us", intro: "Thank you for choosing Furnish Direct. We are a small local business here in Québec, and every order counts for us. Here is a little something in return: <b>$10 off your next purchase</b>.", label: "Your code", cta: "Shop now", h2: "And $10 to give away", give: "Know someone looking for a piece of furniture? Give them this code: they get <b>$10 off their first order</b>, and when they order, we send you <b>$10 more</b>.", friendLabel: "Code to give a friend", sign: "Thank you again,<br>The Furnish Direct team", terms: `$10 off an order of $100 or more (before taxes). One use per code and per customer, cannot be combined with other discounts (free or discounted shipping still applies). Your code is valid until ${until}; the friend code until ${friendUntil}, for a friend's first order. Referral reward: up to 5 friends, sent by email once your friend's order is paid, cancelled if that order is refunded.` }
    : { subject: "Un petit merci de notre part : 10 $ pour vous", pre: "Et 10 $ à offrir à quelqu'un que vous aimez.", title: "Merci de nous avoir choisis", intro: "Merci d'avoir choisi Ameublo Direct. Nous sommes une petite entreprise d'ici, au Québec, et chaque commande compte pour nous. Voici un petit quelque chose en retour : <b>10 $ sur votre prochain achat</b>.", label: "Votre code", cta: "Magasiner", h2: "Et 10 $ à offrir", give: "Vous connaissez quelqu'un qui cherche un meuble? Offrez-lui ce code : il aura <b>10 $ sur sa première commande</b>, et quand il commandera, on vous envoie <b>10 $ de plus</b>.", friendLabel: "Code à offrir", sign: "Encore merci,<br>L'équipe Ameublo Direct", terms: `10 $ sur une commande de 100 $ ou plus (avant taxes). 1 utilisation par code et par client, non cumulable avec d'autres rabais (livraison incluse). Votre code est valide jusqu'au ${until}; le code à offrir jusqu'au ${friendUntil}, pour la première commande d'un ami. Crédit parrain : jusqu'à 5 amis, envoyé par courriel une fois la commande de l'ami payée, annulé si cette commande est remboursée.` };
  const url = `${shop}/discount/${encodeURIComponent(code)}`;
  const plain = (h: string) => h.replace(/<br>/g, "\n").replace(/<[^>]+>/g, "");
  return {
    subject: c.subject, preheader: c.pre,
    bodyHtml: h1(c.title) + p(c.intro) + small(`<b>${esc(c.label)}</b>`) + codeBox(code) + button(url, c.cta)
      + `<h2 style="margin:18px 0 10px;font:bold 19px/1.3 Arial,sans-serif;color:#222">${esc(c.h2)}</h2>` + p(c.give) + small(`<b>${esc(c.friendLabel)}</b>`) + codeBox(friend)
      + p(c.sign) + small(esc(c.terms)),
    bodyText: `${c.title}\n\n${plain(c.intro)}\n\n${c.label} : ${code}\n${c.cta} : ${url}\n\n${c.h2}\n${plain(c.give)}\n${c.friendLabel} : ${friend}\n\n${plain(c.sign)}\n\n${c.terms}`,
    kind: "marketing",
    priority: 3,
    locale: l,
  };
}

export const DIRECT: Record<string, Renderer> = {
  [MORNING_REPORT_EVENT]: (props) => {
    const html = str(props.body_html, 500_000), text = str(props.body_text, 200_000);
    return html ? internal(str(props.subject) || "Rapport matinal", html, text || "Rapport matinal (version HTML seulement).") : null;
  },
  [PUBLISH_ALERT_EVENT]: (props) => {
    const body = str(props.body, 20_000);
    return internal(str(props.subject) || "Alerte publication", `<pre style="white-space:pre-wrap;font:13px/1.5 Consolas,monospace">${esc(body)}</pre>`, body);
  },
  [PRICE_ALERT_CONFIRM_EVENT]: (props) => confirmEmail("price", props),
  [BACK_IN_STOCK_CONFIRM_EVENT]: (props) => confirmEmail("stock", props),
  [PRICE_DROP_EVENT]: (props) => {
    const c = baissePrix(props);
    // the footer follows the email's language (baissePrix already writes FR or EN from the event)
    return c ? { ...c, kind: "marketing", priority: 3, locale: eventLocale(props) } : null;
  },
  [BACK_IN_STOCK_EVENT]: backInStock,
  [REFERRAL_CREDIT_EVENT]: referralCredit,
  [REFERRAL_THANKS_EMAIL]: referralThanks,
};

/** Flow name used in email_sends / Resend tags (ASCII). */
export const DIRECT_FLOW: Record<string, string> = {
  [MORNING_REPORT_EVENT]: "rapport-matinal",
  [PUBLISH_ALERT_EVENT]: "alerte-publication",
  [PRICE_ALERT_CONFIRM_EVENT]: "alerte-prix-confirmation",
  [BACK_IN_STOCK_CONFIRM_EVENT]: "alerte-stock-confirmation",
  [PRICE_DROP_EVENT]: "baisse-prix-alerte",
  [BACK_IN_STOCK_EVENT]: "retour-en-stock",
  [REFERRAL_CREDIT_EVENT]: "parrainage-credit",
  [REFERRAL_THANKS_EMAIL]: "parrainage-merci",
};
