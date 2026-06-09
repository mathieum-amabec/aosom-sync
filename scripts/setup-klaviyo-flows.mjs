/**
 * setup-klaviyo-flows.mjs — create the four core email flows in Klaviyo via the API.
 *
 * Idempotent: re-running skips anything that already exists (matched by name), so it
 * is safe to run repeatedly. Flows are created in **draft** status — nothing sends
 * until a human reviews the copy and flips them to Live in the Klaviyo dashboard.
 *
 * Why revision 2025-01-15 (not 2023-10-15): the Klaviyo *Create Flow* endpoint does
 * not exist before revision 2024-07-15. GETs use 2023-10-15 (the client's revision);
 * the flow/template writes need the newer revision.
 *
 * Bilingual approach: each email template stacks FR (Ameublo Direct) over EN
 * (Furnish Direct). A language conditional-split is intentionally NOT built here —
 * it needs a `Language`/locale profile property that the Shopify→Klaviyo sync does
 * not populate yet (see docs/KLAVIYO-SETUP.md §3). Add the split in the dashboard
 * once that property exists. EN links use ameublodirect.ca/en until furnishdirect.ca
 * is connected (docs/FURNISHDIRECT-DOMAIN-SETUP.md).
 *
 * Run:  node scripts/setup-klaviyo-flows.mjs
 */
import { loadEnv } from "./_shopify-lib.mjs";

const KEY = loadEnv().KLAVIYO_API_KEY;
if (!KEY) throw new Error("KLAVIYO_API_KEY not set in .env.local");

const BASE = "https://a.klaviyo.com/api";
const REV_WRITE = "2025-01-15"; // Create Flow / templates
const REV_READ = "2023-10-15"; // GETs (matches src/lib/klaviyo-client.ts)
const FROM_EMAIL = "info@ameublodirect.ca";
const FROM_LABEL = "AmeubloDirect";
const FR = "https://ameublodirect.ca";
const EN = "https://ameublodirect.ca/en"; // switch to https://furnishdirect.ca once connected

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, rev = REV_WRITE) {
  // Serialize + space requests to stay under Klaviyo's burst limits.
  await sleep(900);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Klaviyo-API-Key ${KEY}`,
        revision: rev,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = Math.min(parseFloat(res.headers.get("Retry-After") || "3"), 20);
      await sleep(wait * 1000);
      continue;
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, ok: res.ok, json, text };
  }
  throw new Error(`${method} ${path} kept throttling`);
}

// Follow cursor pagination and collect every data item.
async function getAll(path, rev = REV_READ) {
  const out = [];
  let url = path;
  while (url) {
    const r = await api("GET", url, null, rev);
    if (!r.ok) throw new Error(`GET ${url} -> ${r.status}: ${r.text.slice(0, 300)}`);
    out.push(...(r.json.data || []));
    const next = r.json.links?.next;
    const nextUrl = next ? next.replace(BASE, "") : null;
    if (nextUrl === url) break; // guard: a self-referential cursor would loop forever
    url = nextUrl;
  }
  return out;
}

// ─── Bilingual email template (FR over EN), email-safe inline HTML ───────────
function tpl({ frH, frP, frCta, frUrl, enH, enP, enCta, enUrl }) {
  const NAVY = "#1B2A4A", GOLD = "#C17F3E", INK = "#1A1A2E", PAPER = "#FAFAF8";
  const btn = (label, url) =>
    `<a href="${url}" style="display:inline-block;background:${GOLD};color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:6px;font-family:Arial,sans-serif;font-size:15px">${label}</a>`;
  const block = (brand, h, p, cta, url) => `
        <tr><td style="padding:8px 0 4px"><span style="font-family:Arial,sans-serif;font-size:13px;letter-spacing:1px;color:${GOLD};font-weight:700;text-transform:uppercase">${brand}</span></td></tr>
        <tr><td style="padding:0 0 10px"><h1 style="margin:0;font-family:Georgia,serif;font-size:24px;line-height:1.25;color:${NAVY}">${h}</h1></td></tr>
        <tr><td style="padding:0 0 18px"><p style="margin:0;font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:${INK}">${p}</p></td></tr>
        <tr><td style="padding:0 0 8px">${btn(cta, url)}</td></tr>`;
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:${PAPER}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid rgba(27,42,74,.08);border-radius:10px;overflow:hidden">
      <tr><td style="background:${NAVY};padding:18px 28px"><span style="font-family:Georgia,serif;font-size:20px;color:#fff;font-weight:700">Ameublo&nbsp;Direct</span><span style="font-family:Arial,sans-serif;font-size:12px;color:#cdd5e3"> &nbsp;|&nbsp; Furnish Direct</span></td></tr>
      <tr><td style="padding:24px 28px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${block("Ameublo Direct", frH, frP, frCta, frUrl)}</table></td></tr>
      <tr><td style="padding:8px 28px"><hr style="border:none;border-top:1px solid #ece6df;margin:0"></td></tr>
      <tr><td style="padding:8px 28px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${block("Furnish Direct", enH, enP, enCta, enUrl)}</table></td></tr>
      <tr><td style="background:${PAPER};padding:18px 28px;border-top:1px solid #ece6df">
        <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;line-height:1.6;color:#797068">
          Ameublo Direct · Québec, Canada · {% unsubscribe %}Se désabonner / Unsubscribe{% endunsubscribe %}
        </p></td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

// ─── Email content (FR primary market: Québec, tutoiement) ──────────────────
const EMAILS = {
  welcome_1: {
    name: "[Flow] Welcome 1 — Bienvenue",
    subject: "Bienvenue chez Ameublo Direct ! 🎉 / Welcome to Furnish Direct!",
    html: tpl({
      frH: "Bienvenue dans la famille !",
      frP: "Merci de t'être inscrit·e. Découvre nos collections coups de cœur : mobilier d'intérieur, ensembles de patio et accessoires pour tes animaux — le tout livré gratuitement partout au Canada.",
      frCta: "Magasiner maintenant", frUrl: `${FR}/collections/all`,
      enH: "Welcome to the family!",
      enP: "Thanks for signing up. Explore our favourite collections: indoor furniture, patio sets and pet accessories — all with free shipping across Canada.",
      enCta: "Shop now", enUrl: `${EN}/collections/all`,
    }),
  },
  welcome_2: {
    name: "[Flow] Welcome 2 — Notre histoire",
    subject: "Notre histoire (et pourquoi on fait ça) / Our story",
    html: tpl({
      frH: "Du beau mobilier, à prix juste",
      frP: "Chez Ameublo Direct, on sélectionne chaque pièce pour sa qualité et son rapport qualité-prix. Pas de marques gonflées : juste du mobilier accessible, une livraison gratuite et un service humain, ici au Québec.",
      frCta: "Découvrir nos meubles", frUrl: `${FR}/collections/meubles-et-decorations`,
      enH: "Beautiful furniture, fair prices",
      enP: "At Furnish Direct, every piece is chosen for its quality and value. No inflated brands — just accessible furniture, free shipping and real, local Canadian service.",
      enCta: "Discover our furniture", enUrl: `${EN}/collections/meubles-et-decorations`,
    }),
  },
  cart_1: {
    name: "[Flow] Cart 1 — Rappel panier",
    subject: "Tu as oublié quelque chose 🛒 / You left something behind",
    html: tpl({
      frH: "Ton panier t'attend",
      frP: "Il reste des articles dans ton panier. Termine ta commande avant qu'ils ne partent — la livraison est gratuite partout au Canada.",
      frCta: "Compléter ma commande", frUrl: `${FR}/cart`,
      enH: "Your cart is waiting",
      enP: "You've still got items in your cart. Complete your order before they're gone — shipping is free across Canada.",
      enCta: "Complete my order", enUrl: `${EN}/cart`,
    }),
  },
  cart_2: {
    name: "[Flow] Cart 2 — Rappel + offre",
    subject: "Toujours intéressé·e ? 🔥 / Still interested?",
    html: tpl({
      frH: "Ton panier est encore là",
      frP: "Les articles que tu as choisis sont populaires et partent vite. On t'a gardé ton panier — profite de la livraison gratuite et finalise ta commande dès maintenant.",
      frCta: "Reprendre ma commande", frUrl: `${FR}/cart`,
      enH: "Your cart is still here",
      enP: "The items you picked are popular and sell fast. We saved your cart — enjoy free shipping and complete your order now.",
      enCta: "Resume my order", enUrl: `${EN}/cart`,
    }),
  },
  postpurchase_1: {
    name: "[Flow] Post-Purchase — Avis",
    subject: "Comment trouves-tu ton achat ? ⭐ / How's your purchase?",
    html: tpl({
      frH: "Partage ton expérience ⭐",
      frP: "Ça fait deux semaines que ta commande est arrivée — on espère que tu l'adores ! Ton avis aide d'autres familles canadiennes à choisir. Ça prend une minute.",
      frCta: "Laisser un avis", frUrl: `${FR}`,
      enH: "Share your experience ⭐",
      enP: "It's been two weeks since your order arrived — we hope you love it! Your review helps other Canadian families choose. It only takes a minute.",
      enCta: "Leave a review", enUrl: `${EN}`,
    }),
  },
  pricedrop_1: {
    name: "[Flow] Price Drop — Notification",
    subject: "Bonne nouvelle — le prix a baissé ! 💸 / Price drop alert!",
    html: tpl({
      frH: "Le prix vient de baisser 💸",
      frP: "Un produit que tu surveilles est maintenant en promotion. Les quantités sont limitées — profites-en avant que le prix ne remonte.",
      frCta: "Voir le produit", frUrl: `{{ event.url|default:'${FR}/collections/rabais' }}`,
      enH: "The price just dropped 💸",
      enP: "A product you're watching is now on sale. Quantities are limited — grab it before the price goes back up.",
      enCta: "View the product", enUrl: `{{ event.url|default:'${EN}/collections/rabais' }}`,
    }),
  },
};

// ─── Idempotent ensure helpers ──────────────────────────────────────────────
async function ensureList(name) {
  const lists = await getAll("/lists/");
  const found = lists.find((l) => l.attributes?.name === name);
  if (found) { console.log(`  list "${name}" exists -> ${found.id}`); return found.id; }
  const r = await api("POST", "/lists/", { data: { type: "list", attributes: { name } } });
  if (!r.ok) throw new Error(`create list failed: ${r.text}`);
  console.log(`  list "${name}" CREATED -> ${r.json.data.id}`);
  return r.json.data.id;
}

async function findMetricId(name) {
  const metrics = await getAll("/metrics/");
  const m = metrics.find((x) => x.attributes?.name === name);
  return m?.id || null;
}

async function ensureTemplate(def) {
  const existing = await getAll("/templates/");
  const found = existing.find((t) => t.attributes?.name === def.name);
  if (found) { console.log(`  template "${def.name}" exists -> ${found.id}`); return found.id; }
  const r = await api("POST", "/templates/", {
    data: { type: "template", attributes: { name: def.name, editor_type: "CODE", html: def.html } },
  });
  if (!r.ok) throw new Error(`create template "${def.name}" failed: ${r.text}`);
  console.log(`  template "${def.name}" CREATED -> ${r.json.data.id}`);
  return r.json.data.id;
}

function emailAction(tempId, email, templateId, next) {
  return {
    temporary_id: tempId,
    type: "send-email",
    data: {
      status: "draft",
      message: {
        subject_line: email.subject,
        from_email: FROM_EMAIL,
        from_label: FROM_LABEL,
        template_id: templateId,
        smart_sending_enabled: true,
      },
    },
    links: { next: next || null },
  };
}
function delayAction(tempId, unit, value, next) {
  return { temporary_id: tempId, type: "time-delay", data: { unit, value, timezone: "profile" }, links: { next: next || null } };
}

async function ensureFlow(name, definition) {
  const flows = await getAll("/flows/");
  const found = flows.find((f) => f.attributes?.name === name);
  if (found) { console.log(`  flow "${name}" exists -> ${found.id} (status=${found.attributes?.status})`); return found.id; }
  const r = await api("POST", "/flows/", { data: { type: "flow", attributes: { name, definition } } });
  if (!r.ok) throw new Error(`create flow "${name}" failed: ${r.text}`);
  console.log(`  flow "${name}" CREATED -> ${r.json.data.id} (status=${r.json.data.attributes?.status})`);
  return r.json.data.id;
}

// ─── Main ───────────────────────────────────────────────────────────────────
const result = { list: {}, metrics: {}, templates: {}, flows: {} };

console.log("1) Newsletter list");
result.list.newsletter = await ensureList("Newsletter");

console.log("\n2) Trigger metrics");
for (const [label, mname] of [
  ["checkoutStarted", "Checkout Started"],
  ["placedOrder", "Placed Order"],
  ["priceDropAlert", "Price Drop Alert"],
]) {
  const id = await findMetricId(mname);
  result.metrics[label] = id;
  console.log(`  metric "${mname}" -> ${id || "MISSING"}`);
}
if (!result.metrics.priceDropAlert) {
  // Bootstrap the custom metric with a single seed event so the flow can trigger on it.
  await api("POST", "/events/", {
    data: { type: "event", attributes: {
      properties: { seed: true },
      metric: { data: { type: "metric", attributes: { name: "Price Drop Alert" } } },
      profile: { data: { type: "profile", attributes: { email: "ops-seed@ameublodirect.ca" } } },
    } },
  }, REV_READ);
  await sleep(2500);
  result.metrics.priceDropAlert = await findMetricId("Price Drop Alert");
  console.log(`  metric "Price Drop Alert" bootstrapped -> ${result.metrics.priceDropAlert}`);
}

// Fail fast: a null trigger-metric id would build a broken flow (or 400 mid-run,
// leaving half the resources created). Require every trigger before touching flows.
const missingMetrics = Object.entries(result.metrics).filter(([, id]) => !id).map(([k]) => k);
if (missingMetrics.length) {
  throw new Error(
    `Cannot build flows — missing trigger metric(s): ${missingMetrics.join(", ")}. ` +
    `Connect the Shopify→Klaviyo integration so "Checkout Started" / "Placed Order" exist, ` +
    `and confirm the "Price Drop Alert" metric materialized, then re-run.`,
  );
}

console.log("\n3) Email templates");
for (const key of Object.keys(EMAILS)) {
  result.templates[key] = await ensureTemplate(EMAILS[key]);
}

console.log("\n4) Flows (draft)");
const T = result.templates;
result.flows.welcome = await ensureFlow("Welcome Series (FR/EN)", {
  triggers: [{ type: "list", id: result.list.newsletter }],
  entry_action_id: "w1",
  actions: [
    emailAction("w1", EMAILS.welcome_1, T.welcome_1, "wd"),
    delayAction("wd", "days", 3, "w2"),
    emailAction("w2", EMAILS.welcome_2, T.welcome_2, null),
  ],
  profile_filter: null,
  reentry_criteria: null,
});
result.flows.abandonedCart = await ensureFlow("Abandoned Cart (FR/EN)", {
  triggers: [{ type: "metric", id: result.metrics.checkoutStarted }],
  entry_action_id: "d1",
  actions: [
    delayAction("d1", "hours", 1, "c1"),
    emailAction("c1", EMAILS.cart_1, T.cart_1, "d2"),
    delayAction("d2", "hours", 23, "c2"), // ~24h after trigger
    emailAction("c2", EMAILS.cart_2, T.cart_2, null),
  ],
  profile_filter: null,
  reentry_criteria: null,
});
result.flows.postPurchase = await ensureFlow("Post-Purchase — Review Request (FR/EN)", {
  triggers: [{ type: "metric", id: result.metrics.placedOrder }],
  entry_action_id: "pd",
  actions: [
    delayAction("pd", "days", 14, "p1"),
    emailAction("p1", EMAILS.postpurchase_1, T.postpurchase_1, null),
  ],
  profile_filter: null,
  reentry_criteria: null,
});
result.flows.priceDrop = await ensureFlow("Price Drop Alert (FR/EN)", {
  triggers: [{ type: "metric", id: result.metrics.priceDropAlert }],
  entry_action_id: "x1",
  actions: [emailAction("x1", EMAILS.pricedrop_1, T.pricedrop_1, null)],
  profile_filter: null,
  reentry_criteria: null,
});

console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(result, null, 2));
