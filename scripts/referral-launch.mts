#!/usr/bin/env tsx
/**
 * scripts/referral-launch.mts — enrol customers in the programme de parrainage (see CLAUDE.md « Parrainage »).
 *
 * DRY RUN by default: reads Shopify (customers + 2 years of orders) and Klaviyo (suppression), prints who is eligible
 * and why others are not. Nothing is written.
 *
 * Eligible: a buyer of the last 2 years (CASL existing business relationship) OR an email subscriber, minus anyone
 * unsubscribed/redacted/invalid on Shopify and anyone unsubscribed or suppressed in Klaviyo (a Klaviyo lookup error
 * EXCLUDES the customer), minus customers already enrolled.
 *
 * With --apply (Mat's OK required), for each eligible customer:
 *   1. Shopify: a personal code MERCI10-XXXXXX (10 $ dès 100 $, 1 use, 60 d) and a friend code AMI-XXXXXX
 *      (10 $ dès 100 $, 10 uses, once per customer, 90 d) — both combine with shipping discounts only;
 *   2. Turso: one `referrals` row (phone/address only as hashes);
 *   3. Klaviyo: profile property `parrainage` {code, code_ami, langue, code_expire, code_ami_expire} and membership
 *      of the FR or EN list (no consent change). The « Un petit merci » campaign is then sent to those lists BY MAT
 *      from Klaviyo, with docs/klaviyo/parrainage-merci.html.
 *
 *   node-x64 --env-file=<main clone>/.env.local node_modules/tsx/dist/cli.mjs scripts/referral-launch.mts \
 *     [--limit 20] [--out eligible.csv] [--apply --list-fr <klaviyoListId> --list-en <klaviyoListId>]
 *
 * List ids may also come from settings `referral_klaviyo_list_fr` / `referral_klaviyo_list_en` (read only here).
 * Re-runnable: already-enrolled customers are skipped, so a crash mid-way is resumed by running it again.
 */
import fs from "node:fs";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const APPLY = argv.includes("--apply");
const LIMIT = flag("--limit") ? Math.max(1, Number(flag("--limit"))) : Infinity;
const OUT = flag("--out");

const mask = (e: string) => e.replace(/^(.)(.*)(@.*)$/, (_m, a: string, b: string, c: string) => `${a}${"*".repeat(Math.min(b.length, 6))}${c}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { getSetting } = await import("@/lib/database");
  const rules = await import("@/lib/referral/rules");
  const launch = await import("@/lib/referral/launch");
  const store = await import("@/lib/referral/store");
  const shop = await import("@/lib/referral/shopify");

  const listFr = flag("--list-fr") ?? (await getSetting("referral_klaviyo_list_fr"));
  const listEn = flag("--list-en") ?? (await getSetting("referral_klaviyo_list_en"));
  if (APPLY && (!listFr || !listEn)) throw new Error("--apply needs both Klaviyo list ids (--list-fr / --list-en or settings referral_klaviyo_list_fr/en)");

  console.log(`\n🎁 referral-launch — ${APPLY ? "APPLY (creates codes, writes Turso + Klaviyo)" : "DRY RUN (nothing is written)"}\n`);
  const since = new Date(Date.now() - launch.BUYER_WINDOW_DAYS * 86_400_000).toISOString();
  const [customers, buyers, enrolled] = await Promise.all([launch.fetchAllCustomers(), launch.fetchRecentBuyerIds(since), store.enrolledKeys()]);
  console.log(`Shopify: ${customers.length} customers, ${buyers.size} bought since ${since.slice(0, 10)}; already enrolled: ${enrolled.emailKeys.size}`);

  const reasons = new Map<string, number>();
  const bump = (k: string) => reasons.set(k, (reasons.get(k) ?? 0) + 1);
  const eligible: Array<{ c: (typeof customers)[number]; source: string; lang: "fr" | "en" }> = [];
  const seenKeys = new Set<string>();
  for (const c of customers) {
    const d = launch.shopifyEligibility(c, buyers, enrolled);
    if (!d.ok) { bump(d.reason); continue; }
    const key = rules.normalizeEmail(c.email) as string;
    if (seenKeys.has(key)) { bump("duplicate-email"); continue; }
    const k = await launch.klaviyoStatus(c.email as string);
    if (k !== "ok") { bump(k === "blocked" ? "klaviyo-suppressed" : "klaviyo-lookup-error"); continue; }
    seenKeys.add(key);
    eligible.push({ c, source: d.source, lang: rules.langOf(c.locale) });
  }

  const fr = eligible.filter((e) => e.lang === "fr").length;
  console.log(`\nEligible: ${eligible.length} (FR ${fr}, EN ${eligible.length - fr})`);
  for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  excluded — ${k}: ${n}`);
  for (const e of eligible.slice(0, 20)) console.log(`  ✓ ${mask(e.c.email as string)}  ${e.lang}  ${e.source}`);
  if (OUT) {
    fs.writeFileSync(OUT, ["customer_id,email,lang,source", ...eligible.map((e) => `${e.c.id},${e.c.email},${e.lang},${e.source}`)].join("\n"), "utf8");
    console.log(`\nCSV written to ${OUT} (contains emails — delete it after use)`);
  }
  if (!APPLY) {
    console.log("\nDry run: nothing written. Re-run with --apply --list-fr <id> --list-en <id> after Mat's OK.");
    return;
  }

  let done = 0, failed = 0;
  for (const e of eligible.slice(0, LIMIT)) {
    const email = (e.c.email as string).trim();
    try {
      const now = new Date();
      const personal = await shop.createReferralDiscount("personal", now);
      const friend = await shop.createReferralDiscount("friend", now);
      const phones = [e.c.phone, ...e.c.addresses.map((a) => a.phone ?? null)].map(rules.normalizePhone).filter((p): p is string => !!p);
      const addrs = e.c.addresses.map(rules.addressKey).filter((a): a is string => !!a);
      const inserted = await store.insertReferral({
        customerId: e.c.id,
        emailKey: rules.normalizeEmail(email) as string,
        email,
        lang: e.lang,
        personalCode: personal.code,
        personalDiscountId: personal.discountId,
        personalExpiresAt: Math.floor(Date.parse(personal.endsAt) / 1000),
        friendCode: friend.code,
        friendDiscountId: friend.discountId,
        friendExpiresAt: Math.floor(Date.parse(friend.endsAt) / 1000),
        phoneHashes: [...new Set(phones.map(rules.identityHash))],
        addressHashes: [...new Set(addrs.map(rules.identityHash))],
        source: e.source,
      });
      if (!inserted) {
        console.warn(`  ! ${mask(email)}: already enrolled meanwhile — codes ${personal.code} / ${friend.code} are orphans, deactivate them in Shopify`);
        failed++;
        continue;
      }
      done++;
      console.log(`  ✓ ${mask(email)} ${e.lang}: ${personal.code} / ${friend.code}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${mask(email)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(700); // Shopify ≤ 2 req/s
  }
  console.log(`\nShopify + Turso: ${done} enrolled, ${failed} failed.`);

  // Klaviyo pass over EVERY enrolled row not synced yet (this run's and any earlier half-finished run's).
  let synced = 0, syncFailed = 0;
  for (const r of await store.unsyncedReferrals()) {
    const iso = (s: number) => new Date(s * 1000).toISOString();
    const prof = await launch.upsertReferralProfile(r.email, {
      code: r.personalCode,
      code_ami: r.friendCode,
      langue: r.lang,
      code_expire: rules.formatExpiry(iso(r.personalExpiresAt), r.lang),
      code_ami_expire: rules.formatExpiry(iso(r.friendExpiresAt), r.lang),
    });
    const list = prof.ok && prof.profileId ? await launch.addProfileToList(r.lang === "en" ? (listEn as string) : (listFr as string), prof.profileId) : null;
    if (prof.ok && list?.ok) {
      await store.markKlaviyoSynced(r.id);
      synced++;
    } else {
      syncFailed++;
      console.error(`  ✗ Klaviyo ${mask(r.email)}: ${prof.error ?? list?.error ?? "unknown"}`);
    }
  }
  console.log(`Klaviyo: ${synced} synced, ${syncFailed} failed (re-run to retry).`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
