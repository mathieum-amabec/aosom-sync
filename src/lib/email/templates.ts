/**
 * The flow emails, as code (FR and EN, one language per email). Copy ported from the Klaviyo
 * templates the relays send today (flow-relay.ts STEPS + relance-paiement.ts), with the same text
 * fixes already applied (returns 10 % + label, 2nd-item discount on the cheaper item).
 *
 * Each renderer reads the trigger event's properties and returns null when the event lacks what the
 * email needs (no checkout link, no code…): better no email than a broken one. Every link in an
 * email comes from our own domains (see `safeUrl`), never blindly from event data.
 */
import { button, esc, type Locale } from "./layout";

export interface EmailContent {
  subject: string;
  preheader: string;
  bodyHtml: string;
  bodyText: string;
}

export type Props = Record<string, unknown>;

const STORE = "https://ameublodirect.ca";
const ALLOWED_HOSTS = new Set(["ameublodirect.ca", "www.ameublodirect.ca", "furnishdirect.ca", "www.furnishdirect.ca", "27u5y2-kp.myshopify.com"]);
const IMAGE_HOSTS = new Set(["cdn.shopify.com", "ameublodirect.ca", "www.ameublodirect.ca"]);

/** An https URL on one of our hosts, else null. */
export function safeUrl(v: unknown, hosts: Set<string> = ALLOWED_HOSTS): string | null {
  if (typeof v !== "string" || v.length > 2000) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && hosts.has(u.hostname.toLowerCase()) ? u.toString() : null;
  } catch {
    return null;
  }
}

const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
export const money = (n: number, l: Locale) => (l === "fr" ? `${n.toFixed(2).replace(".", ",")} $` : `$${n.toFixed(2)}`);
const p = (html: string) => `<p style="margin:0 0 14px">${html}</p>`;
const h1 = (text: string) => `<h1 style="margin:8px 0 14px;font:bold 22px/1.3 Arial,sans-serif;color:#222">${esc(text)}</h1>`;
const small = (html: string) => `<p style="margin:0 0 14px;font-size:13px;color:#666">${html}</p>`;
const codeBox = (code: string) => `<p style="margin:16px 0;text-align:center"><span style="display:inline-block;padding:12px 22px;border:2px dashed #c8553d;border-radius:8px;font:bold 22px/1 'Courier New',monospace;letter-spacing:2px;color:#222">${esc(code)}</span></p>`;
const shopUrl = (l: Locale, path = "/collections/all") => `${STORE}${l === "en" ? "/en" : ""}${path}`;

const PERKS = {
  fr: ["Livraison gratuite partout au Canada", "Retours sous 30 jours (frais de 10 % + étiquette de retour)", "Paiement en 4 versements sans intérêts"],
  en: ["Free shipping anywhere in Canada", "30-day returns (10% fee + return label)", "Pay in 4 interest-free instalments"],
};
const perksHtml = (l: Locale) => p(PERKS[l].map((x) => `✓ ${esc(x)}`).join("<br>"));
const perksText = (l: Locale) => PERKS[l].map((x) => `✓ ${x}`).join("\n");
const REPLY = {
  fr: "Une question sur un produit, la livraison ou les dimensions ? Réponds simplement à ce courriel, une vraie personne d’ici te répond.",
  en: "Any question about a product, delivery or dimensions? Just reply to this email and a real person will answer.",
};

/** Locale from the event (Shopify "Customer Locale", wheel `locale`); French when unknown. */
export function eventLocale(props: Props): Locale {
  const v = str(props["Customer Locale"] ?? props.locale ?? props.$locale).toLowerCase();
  return v.startsWith("en") ? "en" : "fr";
}

// ─── abandoned checkout ────────────────────────────────────────────────

export interface CartItem { title: string; quantity: number; price: number | null; image: string | null }

export function cartFromEvent(props: Props): { url: string | null; items: CartItem[] } {
  const extra = (props.$extra ?? props.extra ?? {}) as Props;
  const lines = Array.isArray(extra.line_items) ? (extra.line_items as Props[]) : [];
  const items = lines.slice(0, 6).map((l) => {
    const product = (l.product ?? {}) as { images?: Array<{ src?: string; thumb_src?: string }> };
    const img = product.images?.[0];
    return {
      title: str(l.presentment_title ?? l.title),
      quantity: Math.max(1, Math.floor(Number(l.quantity) || 1)),
      price: num(l.line_price),
      image: safeUrl(img?.thumb_src ?? img?.src, IMAGE_HOSTS),
    };
  }).filter((i) => i.title);
  return { url: safeUrl(extra.checkout_url), items };
}

function itemsHtml(items: CartItem[], l: Locale): string {
  const rows = items.map((i) => `<tr>${i.image ? `<td width="88" style="padding:8px 12px 8px 0;vertical-align:top"><img src="${esc(i.image)}" width="80" alt="" style="display:block;width:80px;height:auto;border-radius:6px"></td>` : ""}
<td style="padding:8px 0;vertical-align:top">${esc(i.title)}${i.price != null ? `<br><span style="color:#666">${i.quantity > 1 ? `${i.quantity} × ` : ""}${money(i.price, l)}</span>` : ""}</td></tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px">${rows}</table>`;
}
const itemsText = (items: CartItem[], l: Locale) => items.map((i) => `- ${i.title}${i.price != null ? ` (${i.quantity > 1 ? `${i.quantity} × ` : ""}${money(i.price, l)})` : ""}`).join("\n");

const SECOND_ITEM = {
  fr: "<b>Astuce :</b> ajoute un 2<sup>e</sup> article : le moins cher des deux est à <b>10 % de rabais</b>, automatiquement.",
  en: "<b>Tip:</b> add a 2nd item and the cheaper of the two is <b>10% off</b>, automatically.",
};

export function relance1(props: Props): EmailContent | null {
  const l = eventLocale(props);
  const { url, items } = cartFromEvent(props);
  if (!url || !items.length) return null;
  const c = l === "fr"
    ? { subject: "Ton panier t'attend 🛒", pre: "Tes articles sont encore dans ton panier.", title: "Tu as oublié quelque chose ?", intro: "Tu as commencé une commande chez Ameublo Direct sans la terminer. Tes articles t’attendent :", cta: "Reprendre ma commande" }
    : { subject: "Your cart is waiting 🛒", pre: "Your items are still in your cart.", title: "Forgot something?", intro: "You started an order at Furnish Direct but didn't finish it. Your items are waiting:", cta: "Complete my order" };
  return {
    subject: c.subject,
    preheader: c.pre,
    bodyHtml: h1(c.title) + p(esc(c.intro)) + itemsHtml(items, l) + button(url, c.cta) + (items.length < 2 ? p(SECOND_ITEM[l]) : "") + perksHtml(l) + small(esc(REPLY[l])),
    bodyText: `${c.title}\n\n${c.intro}\n${itemsText(items, l)}\n\n${c.cta} : ${url}\n\n${perksText(l)}\n\n${REPLY[l]}`,
  };
}

export function relance2(props: Props): EmailContent | null {
  const l = eventLocale(props);
  const { url, items } = cartFromEvent(props);
  if (!url || !items.length) return null;
  const c = l === "fr"
    ? { subject: "Toujours intéressé·e ? 🔥", pre: "Ton lien te ramène directement à la caisse.", title: "Ton panier t'attend toujours", intro: "Voici ce que tu avais choisi. Livraison gratuite, et ton lien te ramène directement à la caisse, là où tu t’étais arrêté·e.", cta: "Terminer ma commande" }
    : { subject: "Still interested? 🔥", pre: "Your link takes you straight back to checkout.", title: "Your cart is still waiting", intro: "Here's what you picked. Free shipping, and your link takes you straight back to checkout where you left off.", cta: "Complete my order" };
  const shown = items.slice(0, 3);
  return {
    subject: c.subject,
    preheader: c.pre,
    bodyHtml: h1(c.title) + p(esc(c.intro)) + itemsHtml(shown, l) + (items.length < 2 ? p(SECOND_ITEM[l]) : "") + button(url, c.cta) + small(esc(REPLY[l])),
    bodyText: `${c.title}\n\n${c.intro}\n${itemsText(shown, l)}\n\n${c.cta} : ${url}\n\n${REPLY[l]}`,
  };
}

// ─── welcome ───────────────────────────────────────────────────────────

export const WELCOME_CODE = "BIENVENUE20";

export function bienvenue1(props: Props): EmailContent {
  const l = eventLocale(props);
  const c = l === "fr"
    ? { subject: "Bienvenue chez Ameublo Direct ! 🎉", pre: `Ton code ${WELCOME_CODE} : 20 $ de rabais dès 200 $`, title: "Bienvenue dans la famille !", intro: "Merci de t’être inscrit·e. Du beau meuble, sans le gros prix : mobilier d’intérieur, ensembles de patio et accessoires pour tes animaux, livrés gratuitement partout au Canada.", label: "Ton code", offer: "20 $ de rabais sur ta 1<sup>re</sup> commande de 200 $ et plus", offerText: "20 $ de rabais sur ta 1re commande de 200 $ et plus", rules: "Une fois par client, à entrer à la caisse. Non cumulable avec le rabais du 2<sup>e</sup> article.", rulesText: "Une fois par client, à entrer à la caisse. Non cumulable avec le rabais du 2e article.", cta: "Magasiner maintenant" }
    : { subject: "Welcome to Furnish Direct! 🎉", pre: `Your code ${WELCOME_CODE}: $20 off $200+`, title: "Welcome to the family!", intro: "Thanks for signing up. Beautiful furniture, without the big price: indoor furniture, patio sets and pet accessories, all with free shipping across Canada.", label: "Your code", offer: "$20 off your first order of $200+", offerText: "$20 off your first order of $200+", rules: "Once per customer, entered at checkout. Not combinable with the 2nd-item discount.", rulesText: "Once per customer, entered at checkout. Not combinable with the 2nd-item discount.", cta: "Shop now" };
  const url = shopUrl(l);
  return {
    subject: c.subject,
    preheader: c.pre,
    bodyHtml: h1(c.title) + p(esc(c.intro)) + small(`<b>${esc(c.label)}</b>`) + codeBox(WELCOME_CODE) + p(`<b>${c.offer}</b>`) + small(c.rules) + button(url, c.cta) + perksHtml(l),
    bodyText: `${c.title}\n\n${c.intro}\n\n${c.label} : ${WELCOME_CODE}\n${c.offerText}\n${c.rulesText}\n\n${c.cta} : ${url}\n\n${perksText(l)}`,
  };
}

export function bienvenue2(props: Props): EmailContent {
  const l = eventLocale(props);
  const c = l === "fr"
    ? { subject: "Notre histoire (et pourquoi on fait ça)", pre: "Du beau mobilier, à prix juste.", title: "Du beau mobilier, à prix juste", intro: "Chez Ameublo Direct, on sélectionne chaque pièce pour sa qualité et son rapport qualité-prix. Pas de marques gonflées : juste du mobilier accessible, une livraison gratuite et un service humain, ici au Québec.", cta: "Découvrir nos meubles" }
    : { subject: "Our story (and why we do this)", pre: "Beautiful furniture, fair prices.", title: "Beautiful furniture, fair prices", intro: "At Furnish Direct, every piece is chosen for its quality and value. No inflated brands — just accessible furniture, free shipping and real, local Canadian service.", cta: "Discover our furniture" };
  const url = shopUrl(l, "/collections/meubles-et-decorations");
  return { subject: c.subject, preheader: c.pre, bodyHtml: h1(c.title) + p(esc(c.intro)) + button(url, c.cta), bodyText: `${c.title}\n\n${c.intro}\n\n${c.cta} : ${url}` };
}

// ─── wheel (roue de bienvenue) ─────────────────────────────────────────

function wheel(props: Props): { l: Locale; code: string; prize: string; url: string } | null {
  const l = eventLocale(props);
  const code = str(props.code, 40);
  const prize = str(l === "fr" ? props.prize_fr : props.prize_en, 80);
  const url = safeUrl(l === "fr" ? props.apply_url_fr : props.apply_url_en);
  if (!/^[A-Z0-9-]{4,40}$/i.test(code) || !prize || !url) return null;
  return { l, code, prize, url };
}

const WHEEL_RULES = {
  fr: "Le bouton applique le code automatiquement. Usage unique, valide 72 h après la roue, non cumulable avec le rabais du 2e article.",
  en: "The button applies the code for you. Single use, valid 72 h after the spin, not combinable with the 2nd-item discount.",
};
const WHEEL_WHY = {
  fr: "Tu reçois ce courriel parce que tu as tourné la roue et accepté nos courriels.",
  en: "You get this email because you spun the wheel and agreed to our emails.",
};

function wheelEmail(w: NonNullable<ReturnType<typeof wheel>>, c: { subject: string; pre: string; title: string; intro: string; cta: string }): EmailContent {
  return {
    subject: c.subject,
    preheader: c.pre,
    bodyHtml: h1(c.title) + p(esc(c.intro)) + codeBox(w.code) + button(w.url, c.cta) + small(esc(WHEEL_RULES[w.l])) + perksHtml(w.l) + small(esc(WHEEL_WHY[w.l])),
    bodyText: `${c.title}\n\n${c.intro}\n\n${w.code}\n${c.cta} : ${w.url}\n\n${WHEEL_RULES[w.l]}\n\n${perksText(w.l)}\n\n${WHEEL_WHY[w.l]}`,
  };
}

export function roue1(props: Props): EmailContent | null {
  const w = wheel(props);
  if (!w) return null;
  return wheelEmail(w, w.l === "fr"
    ? { subject: `🎁 Ton code : ${w.prize}`, pre: "Valide 72 h, appliqué en un clic.", title: `Bravo ! Tu as gagné ${w.prize}`, intro: "Voici ton code personnel. Il est valide 72 heures.", cta: "Magasiner avec mon code" }
    : { subject: `🎁 Your code: ${w.prize}`, pre: "Valid 72 h, applied in one click.", title: `You won ${w.prize}!`, intro: "Here is your personal code, valid for 72 hours.", cta: "Shop with my code" });
}

export function roue2(props: Props): EmailContent | null {
  const w = wheel(props);
  if (!w) return null;
  return wheelEmail(w, w.l === "fr"
    ? { subject: `Ton code ${w.code} expire dans 48 h`, pre: `${w.prize} t’attend encore.`, title: `Ton rabais de ${w.prize} t'attend`, intro: "Il te reste environ 48 heures pour l’utiliser. Une question sur un meuble ? Réponds à ce courriel, une vraie personne d’ici te répond.", cta: "Utiliser mon code" }
    : { subject: `Your code ${w.code} expires in 48 h`, pre: `${w.prize} is still waiting.`, title: `Your ${w.prize} is waiting`, intro: "About 48 hours left to use it. Questions about an item? Reply to this email and a real person will answer.", cta: "Use my code" });
}

export function roue3(props: Props): EmailContent | null {
  const w = wheel(props);
  if (!w) return null;
  return wheelEmail(w, w.l === "fr"
    ? { subject: `⏰ Dernières heures pour ${w.prize}`, pre: "Ton code expire bientôt.", title: "Dernières heures !", intro: `Ton code de ${w.prize} expire dans environ 12 heures. Après, il ne fonctionnera plus.`, cta: "Profiter de mon rabais" }
    : { subject: `⏰ Last hours for ${w.prize}`, pre: "Your code expires soon.", title: "Last hours!", intro: `Your ${w.prize} code expires in about 12 hours. After that it stops working.`, cta: "Get my discount" });
}

// ─── after purchase ────────────────────────────────────────────────────

export function avis(props: Props): EmailContent {
  const l = eventLocale(props);
  const c = l === "fr"
    ? { subject: "Comment trouves-tu ton achat ? ⭐", pre: "Ça prend une minute.", title: "Partage ton expérience ⭐", intro: "Ta commande est arrivée ? On espère qu’elle te plaît ! Ton avis aide d’autres familles canadiennes à choisir. Ça prend une minute.", cta: "Laisser un avis" }
    : { subject: "How's your purchase? ⭐", pre: "It only takes a minute.", title: "Share your experience ⭐", intro: "Has your order arrived? We hope you love it! Your review helps other Canadian families choose. It only takes a minute.", cta: "Leave a review" };
  const url = shopUrl(l, "/pages/avis-clients");
  return { subject: c.subject, preheader: c.pre, bodyHtml: h1(c.title) + p(esc(c.intro)) + button(url, c.cta) + small(esc(REPLY[l])), bodyText: `${c.title}\n\n${c.intro}\n\n${c.cta} : ${url}\n\n${REPLY[l]}` };
}

// ─── price drop ────────────────────────────────────────────────────────

export function baissePrix(props: Props): EmailContent | null {
  const l = eventLocale(props);
  const url = safeUrl(props.product_url);
  if (!url) return null;
  const name = str(props.product_name, 150);
  const was = num(props.old_price), now = num(props.new_price);
  const prices = was && now && now < was ? { html: `<s style="color:#888">${money(was, l)}</s> &nbsp;<b style="color:#c8553d;font-size:18px">${money(now, l)}</b>`, text: `${money(was, l)} → ${money(now, l)}` } : null;
  const c = l === "fr"
    ? { subject: "Bonne nouvelle : le prix a baissé ! 💸", pre: name ? `${name} est maintenant en promotion.` : "Un produit que tu surveilles est en promotion.", title: "Le prix vient de baisser 💸", intro: "Un produit que tu surveilles est maintenant en promotion.", cta: "Voir le produit" }
    : { subject: "Good news: the price dropped! 💸", pre: name ? `${name} is now on sale.` : "A product you're watching is on sale.", title: "The price just dropped 💸", intro: "A product you're watching is now on sale.", cta: "View the product" };
  return {
    subject: c.subject,
    preheader: c.pre,
    bodyHtml: h1(c.title) + p(esc(c.intro)) + (name ? p(`<b>${esc(name)}</b>`) : "") + (prices ? p(prices.html) : "") + button(url, c.cta) + perksHtml(l),
    bodyText: `${c.title}\n\n${c.intro}\n${name}${prices ? `\n${prices.text}` : ""}\n\n${c.cta} : ${url}\n\n${perksText(l)}`,
  };
}
