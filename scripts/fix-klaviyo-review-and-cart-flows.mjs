/**
 * scripts/fix-klaviyo-review-and-cart-flows.mjs — stop two actively-harmful live flows,
 * and build a correctly-triggered replacement for the review-request flow.
 *
 * Context (2026-09-18 strategic investigation, Part A damage control):
 *
 * 1. Flow `TGfezb` "Post-Purchase — Review Request (FR/EN)" is LIVE, triggered on
 *    `Placed Order` + 14 days. In dropship, delivery can take 1-3 weeks, so the review
 *    request can reach the customer BEFORE the package does (docs/REVIEWS-AUTOMATION.md).
 *    Klaviyo's Flow API only allows PATCHing `status` (draft/manual/live) — the trigger
 *    metric is immutable after creation (confirmed against the Klaviyo API reference).
 *    So the only way to stop the harm is to pause the flow, and the only way to get a
 *    correctly-timed flow is to create a new one on the `Fulfilled Order` metric.
 *
 * 2. Flow `Wcjr3F` "Abandoned Cart (FR/EN)" is LIVE (docs/KLAVIYO-FLOWS.md documented it
 *    as `draft` — that was stale; verified live via GET /flows/ on 2026-09-18). The theme
 *    already runs a 2-screen popup + automatic 10% discount for abandoned-cart recovery
 *    (CLAUDE.md). Both mechanisms targeting the same customer, uncoordinated, is an
 *    active double-discount collision, not a future risk.
 *
 * Modes:
 *   --dry-run   Print current status of every flow + the metric IDs needed. Writes NOTHING.
 *   --apply     Pause TGfezb and Wcjr3F (status -> draft), then create the replacement
 *               "Post-Purchase — Review Request v2 (Fulfilled Order)" flow in draft
 *               (never auto-flipped live — a human reviews copy before that, same as
 *               every other flow this account has ever shipped).
 *
 * Run: node scripts/fix-klaviyo-review-and-cart-flows.mjs --dry-run
 */
import { loadEnv } from "./_shopify-lib.mjs";

const KEY = loadEnv().KLAVIYO_API_KEY;
if (!KEY) throw new Error("KLAVIYO_API_KEY not set in .env.local");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const APPLY = argv.includes("--apply");
if (!DRY_RUN && !APPLY) {
  console.log("usage: fix-klaviyo-review-and-cart-flows.mjs --dry-run | --apply");
  process.exit(1);
}

const BASE = "https://a.klaviyo.com/api";
const REV_WRITE = "2025-01-15";
const REV_READ = "2023-10-15";
const FR = "https://ameublodirect.ca";
const EN = "https://ameublodirect.ca/en";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, rev = REV_WRITE) {
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

async function getAll(path, rev = REV_READ) {
  const out = [];
  let url = path;
  while (url) {
    const r = await api("GET", url, null, rev);
    if (!r.ok) throw new Error(`GET ${url} -> ${r.status}: ${r.text.slice(0, 300)}`);
    out.push(...(r.json.data || []));
    const next = r.json.links?.next;
    const nextUrl = next ? next.replace(BASE, "") : null;
    if (nextUrl === url) break;
    url = nextUrl;
  }
  return out;
}

async function findMetricId(name) {
  const metrics = await getAll("/metrics/");
  const m = metrics.find((x) => x.attributes?.name === name);
  return m?.id || null;
}

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

const REVIEW_V2_EMAIL = {
  name: "[Flow] Post-Purchase v2 — Avis (Fulfilled Order)",
  subject: "Comment trouves-tu ton achat ? ⭐ / How's your purchase?",
  html: tpl({
    frH: "Partage ton expérience ⭐",
    frP: "Ta commande est en route depuis quelques jours — on espère qu'elle te plaît ! Ton avis aide d'autres familles canadiennes à choisir. Ça prend une minute.",
    frCta: "Laisser un avis", frUrl: `${FR}/pages/avis-clients`,
    enH: "Share your experience ⭐",
    enP: "Your order has been on its way for a few days — we hope you love it! Your review helps other Canadian families choose. It only takes a minute.",
    enCta: "Leave a review", enUrl: `${EN}/pages/avis-clients`,
  }),
};

async function main() {
  console.log(`mode: ${DRY_RUN ? "DRY-RUN" : "APPLY"}\n`);

  const flows = await getAll("/flows/?fields[flow]=name,status,trigger_type,updated");
  console.log("Current flow status:");
  for (const f of flows) {
    console.log(`  ${f.id} | ${f.attributes.status} | ${f.attributes.name} | updated ${f.attributes.updated}`);
  }
  console.log("");

  const fulfilledOrderId = await findMetricId("Fulfilled Order");
  const placedOrderId = await findMetricId("Placed Order");
  const checkoutStartedId = await findMetricId("Checkout Started");
  console.log(`Metric "Fulfilled Order" -> ${fulfilledOrderId || "MISSING"}`);
  console.log(`Metric "Placed Order" -> ${placedOrderId || "MISSING"} (used only by TGfezb, per docs/KLAVIYO-FLOWS.md)`);
  console.log(`Metric "Checkout Started" -> ${checkoutStartedId || "MISSING"} (used only by Wcjr3F)`);

  if (!fulfilledOrderId) {
    throw new Error("Fulfilled Order metric not found — cannot build a correctly-timed replacement flow. Aborting.");
  }

  const reviewFlow = flows.find((f) => f.id === "TGfezb");
  const cartFlow = flows.find((f) => f.id === "Wcjr3F");
  if (!reviewFlow || !cartFlow) {
    throw new Error("Expected flows TGfezb and/or Wcjr3F not found — account state has changed, aborting rather than guessing.");
  }

  console.log(`\nTGfezb (review request) current status: ${reviewFlow.attributes.status}`);
  console.log(`Wcjr3F (abandoned cart) current status: ${cartFlow.attributes.status}`);

  if (DRY_RUN) {
    console.log("\n--dry-run: no writes performed.");
    return;
  }

  // 1) Pause the mis-triggered review flow (stops premature sends immediately).
  if (reviewFlow.attributes.status === "live") {
    const r = await api("PATCH", `/flows/${reviewFlow.id}/`, { data: { type: "flow", id: reviewFlow.id, attributes: { status: "draft" } } });
    console.log(`TGfezb -> draft: ${r.ok ? "OK" : "FAILED " + r.text}`);
  } else {
    console.log(`TGfezb already not live (${reviewFlow.attributes.status}) — no change.`);
  }

  // 2) Pause the abandoned-cart flow (theme popup + auto 10% already covers this case).
  if (cartFlow.attributes.status === "live") {
    const r = await api("PATCH", `/flows/${cartFlow.id}/`, { data: { type: "flow", id: cartFlow.id, attributes: { status: "draft" } } });
    console.log(`Wcjr3F -> draft: ${r.ok ? "OK" : "FAILED " + r.text}`);
  } else {
    console.log(`Wcjr3F already not live (${cartFlow.attributes.status}) — no change.`);
  }

  // 3) Create the correctly-triggered replacement review flow, in draft (idempotent by name).
  const existingV2 = flows.find((f) => f.attributes.name === "Post-Purchase — Review Request v2 (Fulfilled Order)");
  if (existingV2) {
    console.log(`\nReplacement flow already exists -> ${existingV2.id} (status=${existingV2.attributes.status}), skipping creation.`);
    return;
  }

  const existingTemplates = await getAll("/templates/");
  let templateId = existingTemplates.find((t) => t.attributes?.name === REVIEW_V2_EMAIL.name)?.id;
  if (!templateId) {
    const rt = await api("POST", "/templates/", { data: { type: "template", attributes: { name: REVIEW_V2_EMAIL.name, editor_type: "CODE", html: REVIEW_V2_EMAIL.html } } });
    if (!rt.ok) throw new Error(`create template failed: ${rt.text}`);
    templateId = rt.json.data.id;
    console.log(`\nTemplate "${REVIEW_V2_EMAIL.name}" CREATED -> ${templateId}`);
  }

  const definition = {
    triggers: [{ type: "metric", id: fulfilledOrderId }],
    entry_action_id: "pd",
    actions: [
      {
        temporary_id: "pd",
        type: "time-delay",
        data: { unit: "days", value: 10, timezone: "profile" },
        links: { next: "p1" },
      },
      {
        temporary_id: "p1",
        type: "send-email",
        data: {
          status: "draft",
          message: {
            subject_line: REVIEW_V2_EMAIL.subject,
            from_email: "info@ameublodirect.ca",
            from_label: "AmeubloDirect",
            template_id: templateId,
            smart_sending_enabled: true,
          },
        },
        links: { next: null },
      },
    ],
    profile_filter: null,
    reentry_criteria: null,
  };
  const rf = await api("POST", "/flows/", {
    data: { type: "flow", attributes: { name: "Post-Purchase — Review Request v2 (Fulfilled Order)", definition } },
  });
  if (!rf.ok) throw new Error(`create replacement flow failed: ${rf.text}`);
  console.log(`Replacement flow CREATED -> ${rf.json.data.id} (status=${rf.json.data.attributes?.status}) — LEFT IN DRAFT, human review required before any Live flip.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
