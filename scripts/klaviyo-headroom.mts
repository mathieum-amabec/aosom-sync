#!/usr/bin/env tsx
/**
 * scripts/klaviyo-headroom.mts — room under Klaviyo's free plan until the switch to Resend (docs/EMAIL-GRATUIT.md).
 *
 * Klaviyo free = 250 ACTIVE profiles; above it, Klaviyo blocks EVERY send (wheel codes, cart reminders, morning
 * report…). A SUPPRESSED profile no longer counts, and a suppression is reversible (unlike a deletion, which this
 * script never does).
 *
 * DRY RUN by default: reads Klaviyo (profiles, Placed Order / cart / checkout / wheel events) and Shopify (customers,
 * orders), prints counts per category and how many profiles could be suppressed. Nothing is written.
 *
 * Candidates = active profiles that are neither buyers nor subscribers (Klaviyo OR Shopify), created more than 14 days
 * ago, with no reminder still possible (no cart / checkout / wheel event in the last 7 days), not internal, with an
 * email (src/lib/email/klaviyo-headroom.ts has the exact rules, and the tests).
 *
 * Also prints, as COUNTS ONLY, the Shopify subscribers whose Klaviyo profile is suppressed (the 2026-11-13 clean-up).
 *
 *   node-x64 --env-file=<main clone>/.env.local node_modules/tsx/dist/cli.mjs scripts/klaviyo-headroom.mts
 *     [--keep a@x.ca,b@y.ca]             never touch these addresses (MORNING_REPORT_EMAIL is always kept)
 *     [--apply [--max 60]]               SUPPRESS the candidates (Mat's OK required), backup file in .context/
 *     [--undo .context/klaviyo-headroom-….json]   lift the suppressions listed in that backup
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const APPLY = argv.includes("--apply");
const UNDO = flag("--undo");
const MAX = flag("--max") ? Math.max(1, Number(flag("--max"))) : Infinity;
const KEEP = (flag("--keep") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const PLACED_ORDER = "SbdeEU", CHECKOUT_STARTED = "Rycc4h", ADDED_TO_CART = "SmdQyJ", WHEEL_WON = "V5gzPH";

type KProfile = { id: string; attributes: { email?: string | null; created?: string | null; subscriptions?: { email?: { marketing?: { consent?: string; suppression?: Array<{ reason?: string; timestamp?: string }> } } } } };

async function main() {
  const { kv, metricEvents } = await import("@/lib/klaviyo-campaigns");
  const hr = await import("@/lib/email/klaviyo-headroom");

  if (UNDO) {
    const emails = (JSON.parse(fs.readFileSync(UNDO, "utf8")) as { emails: string[] }).emails;
    console.log(`Undo: lifting the suppression of ${emails.length} profile(s) listed in ${UNDO}`);
    for (let i = 0; i < emails.length; i += 100) await kv("POST", "/profile-suppression-bulk-delete-jobs/", hr.suppressionJob(emails.slice(i, i + 100), true));
    console.log("Jobs submitted (Klaviyo processes them within a few minutes).");
    return;
  }

  console.log(`\n🧹 klaviyo-headroom — ${APPLY ? "APPLY (suppresses, reversible)" : "DRY RUN (nothing is written)"}\n`);
  const now = new Date();
  const profiles: KProfile[] = [];
  let next: string | null = "/profiles/?fields[profile]=email,created,subscriptions&additional-fields[profile]=subscriptions&page[size]=100";
  while (next) {
    const j: { data: KProfile[]; links?: { next?: string | null } } = await kv("GET", next);
    profiles.push(...j.data);
    next = j.links?.next ? j.links.next.replace("https://a.klaviyo.com/api", "") : null;
  }
  const iso = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 19);
  const ids = async (metric: string, sinceDays: number) => new Set((await metricEvents(metric, iso(sinceDays))).events.map((e) => e.relationships?.profile?.data?.id).filter((x): x is string => !!x));
  const buyerIds = await ids(PLACED_ORDER, 3650);
  const ongoingIds = new Set([...(await ids(CHECKOUT_STARTED, 7)), ...(await ids(ADDED_TO_CART, 7)), ...(await ids(WHEEL_WON, 7))]);

  // Shopify: every customer, their consent, and who ever ordered (read only)
  const launch = await import("@/lib/referral/launch");
  const [customers, buyerCustomerIds] = await Promise.all([launch.fetchAllCustomers(), launch.fetchRecentBuyerIds("2020-01-01T00:00:00.000Z")]);
  const lc = (e: string | null) => (e ?? "").trim().toLowerCase();
  const shopifyBuyerEmails = new Set(customers.filter((c) => buyerCustomerIds.has(c.id)).map((c) => lc(c.email)).filter(Boolean));
  const shopifySubscriberEmails = new Set(customers.filter((c) => (c.marketingState ?? "").toUpperCase() === "SUBSCRIBED").map((c) => lc(c.email)).filter(Boolean));
  const protectedEmails = new Set([...KEEP, lc(process.env.MORNING_REPORT_EMAIL ?? null)].filter(Boolean));

  const report = hr.buildReport(profiles.map((p) => {
    const m = p.attributes.subscriptions?.email?.marketing;
    const sup = Array.isArray(m?.suppression) ? m!.suppression! : [];
    return { id: p.id, email: p.attributes.email ?? null, created: p.attributes.created ?? null, consent: m?.consent ?? null, suppressed: sup.length > 0, suppressedAt: sup.map((s) => s.timestamp ?? "") };
  }), { now, buyerIds, shopifyBuyerEmails, shopifySubscriberEmails, ongoingIds, protectedEmails });

  const label: Record<string, string> = {
    "deja-bloque": "déjà bloqués (ne comptent pas)", acheteur: "acheteurs (gardés)", abonne: "abonnés (gardés)", recent: "créés il y a < 14 jours (gardés)",
    "relance-en-cours": "relance possible en cours (gardés)", interne: "adresses internes (gardés)", "sans-courriel": "sans courriel (gardés)", "a-bloquer": "À BLOQUER (ni acheteurs ni abonnés)",
  };
  console.log(`Klaviyo : ${report.total} profils, ${report.active} actifs (forfait gratuit : 250).`);
  for (const [k, n] of Object.entries(report.byVerdict)) console.log(`  ${String(n).padStart(4)}  ${label[k]}`);
  const take = report.candidates.slice(0, MAX);
  console.log(`\nActifs après blocage : ${report.active - take.length} (marge : ${250 - (report.active - take.length)} profils).`);
  console.log(`Shopify : ${customers.length} clients, ${shopifySubscriberEmails.size} acceptent le courriel, ${shopifyBuyerEmails.size} ont commandé.`);
  console.log(`Abonnés Shopify dont le profil Klaviyo est bloqué : ${report.shopifySubscribersBlocked.total} (dont ${report.shopifySubscribersBlocked.on20261113} bloqués le 2026-11-13). Comptes seulement.`);

  if (!APPLY) {
    console.log("\nDry run : rien n'a été écrit. Avec l'accord de Mat : --apply (réversible avec --undo <fichier>).");
    return;
  }
  if (!take.length) { console.log("Rien à bloquer."); return; }
  const dir = path.resolve(".context");
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `klaviyo-headroom-${now.toISOString().replace(/[:.]/g, "-")}.json`);
  // the backup holds addresses: it lives in .context/ (git-ignored), only to undo this run
  fs.writeFileSync(backup, JSON.stringify({ at: now.toISOString(), emails: take.map((c) => c.email) }, null, 1), "utf8");
  for (let i = 0; i < take.length; i += 100) await kv("POST", "/profile-suppression-bulk-create-jobs/", hr.suppressionJob(take.slice(i, i + 100).map((c) => c.email)));
  console.log(`\n${take.length} profil(s) bloqué(s) (suppression réversible). Sauvegarde : ${backup}\nAnnuler : --undo ${backup}`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
