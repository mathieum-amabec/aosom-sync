/**
 * Free email (2026-11-27): the single switch `email_provider`, Resend's 100/day cap with priorities, the outbox
 * that spreads, idempotency, consent/unsubscribe sync (Turso + Shopify), wheel spins without Klaviyo, referral
 * emails via Resend, and the Klaviyo headroom rules.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

import {
  TIER_SHARE, buildEmail, capAllows, loadEngineConfig, modeForProvider, parseProvider, sendEmail,
  type EngineConfig, type EngineDeps, type OutgoingEmail, type SendOutcome,
} from "@/lib/email/engine";
import { defaultIdemKey, directEmail, dispatchEvent, routeFor, type DispatchDeps } from "@/lib/email/dispatch";
import { MORNING_REPORT_EVENT, PRICE_ALERT_CONFIRM_EVENT, REFERRAL_CREDIT_EVENT, REFERRAL_THANKS_EMAIL } from "@/lib/email/direct";
import { drainOutbox, spreadOverDays, type OutboxItem } from "@/lib/email/outbox";
import { GROUPS, allRelayKeys, effectiveTakeover, emptyEngineState, loadRelayKeysOwnedByEngine, relayView, runEmailFlows, type EngineState, type FlowRunDeps } from "@/lib/email/flows";
import { STEPS as RELAY_STEPS, type TriggerEvent } from "@/lib/flow-relay";
import { mergeWheelEvents, spinToEvent, wheelEventProps } from "@/lib/email/wheel-source";
import { WHEEL_PRIZES } from "@/lib/welcome-wheel";
import { ShopifyConsentRefused, setShopifyEmailConsent } from "@/lib/email/shopify-consent";
import { buildReport, classifyProfile, suppressionJob, type HeadroomContext } from "@/lib/email/klaviyo-headroom";
import { CREDIT_EVENT } from "@/lib/referral/credits";
import { relance2Email } from "@/lib/relance-code";
import { cartEmail } from "@/lib/cart-relay";
import type { CheckoutEvent } from "@/lib/relance-paiement";

const SECRET = "s".repeat(40);
const READY_ENV = { RESEND_API_KEY: "re_x", EMAIL_FROM: "Ameublo Direct <bonjour@ameublodirect.ca>", EMAIL_TOKEN_SECRET: SECRET };

const cfg = (over: Partial<EngineConfig> = {}): EngineConfig => ({
  mode: "live", provider: "resend", providerSince: null, dailyCap: 95, monthlyCap: 2900, testRecipients: new Set(),
  mailingAddress: "C.P. 123, Saint-Hubert QC J3Y 0A1", from: "Ameublo Direct <bonjour@ameublodirect.ca>", replyTo: "",
  apiKey: "re_test", tokenSecret: SECRET, baseUrl: "https://outils.ameublodirect.ca", ...over,
});
const msg = (over: Partial<OutgoingEmail> = {}): OutgoingEmail => ({
  to: "client@example.com", flow: "roue-1", idemKey: "roue-1:e1", kind: "marketing", locale: "fr",
  subject: "s", preheader: "p", bodyHtml: "<p>x</p>", bodyText: "x", ...over,
});

describe("the switch: settings email_provider", () => {
  it("defaults to klaviyo and leaves the legacy engine mode alone", () => {
    expect(parseProvider(null)).toBe("klaviyo");
    expect(parseProvider("RESEND")).toBe("klaviyo");
    expect(parseProvider("resend")).toBe("resend");
    expect(modeForProvider("klaviyo", "off")).toBe("off");
    expect(modeForProvider("klaviyo", "live")).toBe("live");
    expect(modeForProvider("test", "off")).toBe("test");
    expect(modeForProvider("resend", "off")).toBe("live");
  });

  it("a provider with missing configuration routes to Klaviyo (fail safe)", async () => {
    const settings: Record<string, string> = { email_provider: "resend", email_mailing_address: "C.P. 123, Saint-Hubert QC" };
    const get = async (k: string) => settings[k] ?? null;
    const broken = await loadEngineConfig(get, {});
    expect(broken.mode).toBe("live");
    expect(routeFor(broken)).toBe("klaviyo");
    const ok = await loadEngineConfig(get, READY_ENV);
    expect(ok.dailyCap).toBe(95);
    expect(routeFor({ ...ok, baseUrl: "https://outils.ameublodirect.ca" })).toBe("resend");
    expect(routeFor(cfg({ provider: "klaviyo" }))).toBe("klaviyo");
    expect(routeFor(cfg({ provider: "test" }))).toBe("test");
    expect((await loadEngineConfig(async (k) => (k === "email_daily_cap" ? "300" : null), {})).dailyCap).toBe(300);
  });

  it("resend: every relay key is owned (the relays stand down), every group is taken over", async () => {
    expect(allRelayKeys()).toEqual(new Set([...RELAY_STEPS.map((s) => s.key), "relance-paiement"]));
    expect(Object.keys(effectiveTakeover({ provider: "resend", providerSince: "2026-12-01T00:00:00.000Z" }, {}))).toEqual(GROUPS);
    expect(effectiveTakeover({ provider: "klaviyo", providerSince: null }, { roue: "x" })).toEqual({ roue: "x" });
    // no NEXT_PUBLIC_APP_URL / Resend key in the test env → configuration incomplete → the relays keep everything
    const s: Record<string, string> = { email_provider: "resend" };
    expect((await loadRelayKeysOwnedByEngine(async (k) => s[k] ?? null)).size).toBe(0);
    expect((await loadRelayKeysOwnedByEngine(async () => null)).size).toBe(0);
  });
});

describe("Resend daily cap and priorities", () => {
  it("lower tiers leave room for the important emails", () => {
    const caps = { daily: 100, monthly: 3000 };
    expect(TIER_SHARE[0]).toBe(1);
    expect(capAllows(0, 99, 0, caps)).toBe("ok");
    expect(capAllows(0, 100, 0, caps)).toBe("daily-cap");
    expect(capAllows(1, 89, 0, caps)).toBe("ok");
    expect(capAllows(1, 90, 0, caps)).toBe("daily-cap");
    expect(capAllows(3, 59, 0, caps)).toBe("ok");
    expect(capAllows(3, 60, 0, caps)).toBe("daily-cap");
    expect(capAllows(0, 0, 3000, caps)).toBe("monthly-cap");
  });

  it("sendEmail refuses BEFORE claiming the email when the tier is full; a wheel code still passes", async () => {
    const reserve = vi.fn(async () => 1);
    const deps: EngineDeps = { isSuppressed: async () => false, reserve, finish: async () => {}, send: async () => ({ ok: true, id: "re_1" }), countSentSince: async () => 70, now: () => new Date() };
    const marketing = await sendEmail(msg({ priority: 3 }), cfg(), deps);
    expect(marketing).toMatchObject({ status: "skipped", reason: "daily-cap" });
    expect(reserve).not.toHaveBeenCalled();
    expect(await sendEmail(msg({ priority: 0 }), cfg(), deps)).toEqual({ status: "sent", id: "re_1" });
  });
});

describe("outbox: spreads under the cap, never twice", () => {
  const NOW = new Date("2026-12-01T15:00:00Z");
  const row = (id: number, priority: number, over: Partial<OutboxItem> = {}): OutboxItem => ({
    id, idemKey: `k${id}`, priority, notBefore: 0, expiresAt: NOW.getTime() / 1000 + 3600, attempts: 0, payload: JSON.stringify(msg({ idemKey: "ignored" })), ...over,
  });

  it("sends highest priority first, stops at the cap, expires the stale, retries hiccups a few times", async () => {
    const finish = vi.fn(async () => {});
    const outcomes: SendOutcome[] = [
      { status: "sent", id: "a" },
      { status: "skipped", reason: "duplicate" },
      { status: "failed", error: "500", retryable: true },
      { status: "skipped", reason: "daily-cap" },
    ];
    const send = vi.fn(async (m: OutgoingEmail) => { void m; return outcomes.shift()!; });
    const r = await drainOutbox({ now: NOW, due: async () => [row(9, 0, { expiresAt: 1 }), row(1, 0), row(2, 1), row(3, 1), row(4, 3), row(5, 3)], finish, send, timeLeft: () => true });
    expect(r).toMatchObject({ sent: 2, expired: 1, waiting: 1, stoppedBy: "daily-cap" });
    expect(send.mock.calls.map((c) => (c[0] as OutgoingEmail).idemKey)).toEqual(["k1", "k2", "k3", "k4"]); // the row's own key
    expect(finish).toHaveBeenCalledWith(9, "expired", "trop tard");
    expect(finish).toHaveBeenCalledWith(3, "pending", "500");
    expect(finish).not.toHaveBeenCalledWith(5, expect.anything(), expect.anything());
  });

  it("test mode leaves customers' emails waiting; a 5th failure gives up", async () => {
    const finish = vi.fn(async () => {});
    const r = await drainOutbox({ now: NOW, due: async () => [row(1, 3), row(2, 3, { attempts: 4 })], finish,
      send: vi.fn().mockResolvedValueOnce({ status: "skipped", reason: "not-test-recipient" }).mockResolvedValueOnce({ status: "failed", error: "x", retryable: true }), timeLeft: () => true });
    expect(r).toMatchObject({ waiting: 1, failed: 1 });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(2, "failed", "x");
  });

  it("spreads a bulk send over days at 9 h Montréal", () => {
    const t = spreadOverDays(5, 2, new Date("2026-12-01T15:00:00Z"));
    expect(t.map((s) => new Date(s * 1000).toISOString())).toEqual([
      "2026-12-02T14:00:00.000Z", "2026-12-02T14:00:00.000Z", "2026-12-03T14:00:00.000Z", "2026-12-03T14:00:00.000Z", "2026-12-04T14:00:00.000Z",
    ]);
    expect(spreadOverDays(1, 50, new Date("2026-12-01T10:00:00Z"))[0]).toBe(Date.parse("2026-12-01T14:00:00Z") / 1000);
  });
});

describe("dispatchEvent: one call, Klaviyo or Resend", () => {
  const settings = (provider: string, test = ""): DispatchDeps["getSetting"] => async (k) =>
    ({ email_provider: provider, email_mailing_address: "C.P. 123, Saint-Hubert QC J3Y 0A1", email_test_recipients: test } as Record<string, string>)[k] ?? null;
  const report = { subject: "Rapport", body_html: "<div>ok</div>", body_text: "ok" };

  function deps(provider: string, send: DispatchDeps["send"], test = "") {
    const trackEvent = vi.fn(async () => ({ ok: true }));
    const enqueue = vi.fn(async (e: { idemKey: string; priority: number }) => { void e; return true; });
    return { d: { getSetting: settings(provider, test), trackEvent, send, enqueue } as DispatchDeps, trackEvent, enqueue };
  }

  beforeAll(() => {
    process.env.RESEND_API_KEY = "re_x";
    process.env.EMAIL_FROM = "Ameublo Direct <bonjour@ameublodirect.ca>";
    process.env.EMAIL_TOKEN_SECRET = SECRET;
    process.env.NEXT_PUBLIC_APP_URL = "https://outils.ameublodirect.ca";
  });

  it("klaviyo (default): the Klaviyo event only, exactly as before", async () => {
    const send = vi.fn();
    const { d, trackEvent } = deps("klaviyo", send);
    expect(await dispatchEvent(MORNING_REPORT_EVENT, "mat@x.ca", report, {}, d)).toEqual({ ok: true, via: "klaviyo" });
    expect(trackEvent).toHaveBeenCalledWith(MORNING_REPORT_EVENT, "mat@x.ca", report);
    expect(send).not.toHaveBeenCalled();
  });

  it("resend: no Klaviyo call; a cap or a hiccup queues; a repeat is a duplicate, never a 2nd email", async () => {
    const send = vi.fn(async (m: OutgoingEmail) => { void m; return { status: "sent" as const, id: "re_1" }; });
    const { d, trackEvent, enqueue } = deps("resend", send);
    expect(await dispatchEvent(MORNING_REPORT_EVENT, "mat@x.ca", report, { idemKey: "rapport-matinal:2026-12-01" }, d)).toEqual({ ok: true, via: "resend" });
    expect(trackEvent).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0]).toMatchObject({ to: "mat@x.ca", flow: "rapport-matinal", kind: "transactional", priority: 0, idemKey: "rapport-matinal:2026-12-01" });

    send.mockResolvedValueOnce({ status: "skipped", reason: "duplicate" } as never);
    expect((await dispatchEvent(MORNING_REPORT_EVENT, "mat@x.ca", report, { idemKey: "rapport-matinal:2026-12-01" }, d)).ok).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();

    send.mockResolvedValueOnce({ status: "skipped", reason: "daily-cap" } as never);
    expect(await dispatchEvent(MORNING_REPORT_EVENT, "mat@x.ca", report, { idemKey: "k2", maxDelayH: 12 }, d)).toEqual({ ok: true, via: "queued" });
    expect(enqueue.mock.calls[0][0]).toMatchObject({ idemKey: "k2", priority: 0 });

    send.mockResolvedValueOnce({ status: "skipped", reason: "suppressed" } as never);
    expect(await dispatchEvent(PRICE_ALERT_CONFIRM_EVENT, "c@x.ca", { confirm_url: "https://outils.ameublodirect.ca/api/price-alert/confirm?token=t", product_name: "Lit" }, {}, d))
      .toMatchObject({ ok: true, skipped: true, error: "suppressed" });
    // data the email needs is missing (a link off our hosts): NOT ok, so the caller keeps the item instead of stamping it
    expect(await dispatchEvent(PRICE_ALERT_CONFIRM_EVENT, "c@x.ca", { confirm_url: "https://admin.shopify.com/x", product_name: "Lit" }, {}, d))
      .toMatchObject({ ok: false, via: "none", error: "données incomplètes" });
  });

  it("the default idem key is stable for the same data and differs otherwise", () => {
    expect(defaultIdemKey(CREDIT_EVENT, "A@x.ca", { code: "MERCI10-AAA" })).toBe(defaultIdemKey(CREDIT_EVENT, "a@x.ca ", { code: "MERCI10-AAA" }));
    expect(defaultIdemKey(CREDIT_EVENT, "a@x.ca", { code: "MERCI10-AAA" })).not.toBe(defaultIdemKey(CREDIT_EVENT, "a@x.ca", { code: "MERCI10-BBB" }));
  });

  it("test: Klaviyo for everyone, plus a Resend copy for the test addresses only", async () => {
    const send = vi.fn(async (m: OutgoingEmail) => { void m; return { status: "sent" as const, id: "re" }; });
    const { d, trackEvent } = deps("test", send, "mat@x.ca");
    await dispatchEvent(MORNING_REPORT_EVENT, "client@x.ca", report, {}, d);
    expect(send).not.toHaveBeenCalled();
    await dispatchEvent(MORNING_REPORT_EVENT, "mat@x.ca", report, { idemKey: "r" }, d);
    expect(trackEvent).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toMatchObject({ idemKey: "test:r" });
  });

  it("an unknown event always goes to Klaviyo; a confirmation link outside our app is refused", async () => {
    const { d, trackEvent } = deps("resend", vi.fn());
    await dispatchEvent("Something Else", "c@x.ca", {}, {}, d);
    expect(trackEvent).toHaveBeenCalled();
    expect(directEmail(PRICE_ALERT_CONFIRM_EVENT, "c@x.ca", { confirm_url: "https://evil.example/x" }, "k")).toBeNull();
  });
});

describe("referral emails through Resend", () => {
  it("the credit email (courriel 2) carries the code, never the friend, and respects unsubscribes", () => {
    const m = directEmail(CREDIT_EVENT, "parrain@x.ca", { code: "MERCI10-ABC234", montant: 10, minimum: 100, expire_le: "26 janvier 2027", langue: "fr" }, "parrainage-credit:MERCI10-ABC234")!;
    expect(CREDIT_EVENT).toBe(REFERRAL_CREDIT_EVENT);
    expect(m).toMatchObject({ kind: "marketing", priority: 0, locale: "fr", subject: "Votre ami a commandé : voici vos 10 $" });
    expect(m.bodyHtml).toContain("MERCI10-ABC234");
    expect(m.bodyHtml).toContain("https://ameublodirect.ca/discount/MERCI10-ABC234");
    const en = directEmail(CREDIT_EVENT, "p@x.ca", { code: "MERCI10-ABC234", langue: "en", expire_le: "January 26, 2027" }, "k")!;
    expect(en.subject).toBe("Your friend placed an order: here is your $10");
    expect(directEmail(CREDIT_EVENT, "p@x.ca", { code: "<b>" }, "k")).toBeNull();
  });

  it("the thank-you email (courriel 1) has both codes and is marketing (60 % of the cap at most)", () => {
    const m = directEmail(REFERRAL_THANKS_EMAIL, "c@x.ca", { code: "MERCI10-AAA222", code_ami: "AMI-BBB333", langue: "fr", code_expire: "1 févr.", code_ami_expire: "1 mars" }, "parrainage-merci:1")!;
    expect(m).toMatchObject({ priority: 3, kind: "marketing" });
    expect(m.bodyHtml).toContain("MERCI10-AAA222");
    expect(m.bodyHtml).toContain("AMI-BBB333");
    // the footer (sender, address, unsubscribe link) is added for every email
    const built = buildEmail(m, cfg());
    expect(built.html).toContain("/api/email/unsubscribe?e=");
    expect(built.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("the referral cron's notifyCredit goes through dispatch with one key per credit code", async () => {
    vi.resetModules();
    const dispatch = vi.fn(async () => ({ ok: true, via: "resend" }));
    vi.doMock("@/lib/email/dispatch", () => ({ dispatchEvent: dispatch }));
    const { defaultReferralDeps } = await import("@/lib/referral/deps");
    await defaultReferralDeps().notifyCredit("p@x.ca", { code: "MERCI10-ZZZ" });
    expect(dispatch).toHaveBeenCalledWith(CREDIT_EVENT, "p@x.ca", { code: "MERCI10-ZZZ" }, { idemKey: "parrainage-credit:MERCI10-ZZZ", maxDelayH: 168 });
    vi.doUnmock("@/lib/email/dispatch");
  });
});

describe("wheel spins without Klaviyo", () => {
  const prize = WHEEL_PRIZES[0];
  const row = { id: 1, email: "Spin@Client.ca", prize_key: prize.key, code: "ROUE-ABC123", expires_at: 1_800_000_000, locale: "fr", created_at: 1_799_740_000 };

  it("a Turso spin becomes the same trigger as the Klaviyo event, without double", () => {
    const ev = spinToEvent(row, WHEEL_PRIZES)!;
    expect(ev).toMatchObject({ id: "spin:ROUE-ABC123", profileId: "email:spin@client.ca", email: "Spin@Client.ca" });
    expect(ev.props).toEqual(wheelEventProps("ROUE-ABC123", prize, new Date(1_800_000_000_000).toISOString(), "fr"));
    const k: TriggerEvent = { id: "k1", profileId: "p1", email: "x@y.ca", at: "t", props: { code: "ROUE-ABC123" } };
    expect(mergeWheelEvents([k], [row], WHEEL_PRIZES)).toEqual([k]);
    expect(mergeWheelEvents([], [row, { ...row, code: null }], WHEEL_PRIZES)).toHaveLength(1);
  });

  it("the engine mails it, sees the person's order by email, and a cap only postpones", async () => {
    const NOW = new Date((row.created_at + 15 * 60) * 1000);
    const ev = spinToEvent(row, WHEEL_PRIZES)!;
    let saved: EngineState | null = emptyEngineState(new Date(NOW.getTime() - 3600e3).toISOString());
    const consentOf = vi.fn(async (pid: string) => ({ consent: pid.startsWith("email:") ? "SUBSCRIBED" : "UNKNOWN", suppressed: false }));
    const base = (send: FlowRunDeps["send"], orders: TriggerEvent[] = []): FlowRunDeps => ({
      now: NOW, mode: "live", takeover: { roue: new Date(NOW.getTime() - 86_400e3).toISOString() },
      loadState: async () => saved, saveState: async (s) => { saved = JSON.parse(JSON.stringify(s)); },
      events: async (m) => (m === "V5gzPH" ? [ev] : m === "SbdeEU" ? orders : []), relay: relayView(null, null),
      relance1Sent: async () => false, flowSendingAgain: () => false, consentOf, recipientAllowed: () => true, send, timeLeft: () => true,
    });
    const capped = await runEmailFlows(base(async () => ({ status: "skipped", reason: "daily-cap" })));
    expect(capped.skipped).toEqual({ "roue-1:daily-cap": 1 });
    expect(saved!.done["roue-1"]?.[ev.id]).toBeUndefined(); // retried next run
    // an order by the same email (Klaviyo profile) after the spin: no wheel reminder
    const send = vi.fn(async () => ({ status: "sent" as const, id: "re" }));
    const order: TriggerEvent = { id: "o1", profileId: "kp-9", email: "spin@client.ca", at: new Date(NOW.getTime() - 60e3).toISOString(), props: {} };
    await runEmailFlows(base(send, [order]));
    expect(send).not.toHaveBeenCalled();
    await runEmailFlows(base(send));
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown as [OutgoingEmail])[0]).toMatchObject({ idemKey: "roue-1:spin:ROUE-ABC123", priority: 0 });
    expect(consentOf).toHaveBeenCalledWith("email:spin@client.ca");
  });

  it("the generic checkout reminder #2 yields to the 15 $ code email", async () => {
    const NOW = new Date("2026-12-01T12:00:00Z");
    const c: TriggerEvent = { id: "c9", profileId: "p9", email: "c9@x.ca", at: new Date(NOW.getTime() - (24 * 60 + 15) * 60e3).toISOString(), props: { $extra: { checkout_url: "https://ameublodirect.ca/c/1", line_items: [{ title: "Lit", quantity: 1, line_price: 300 }] } } };
    const send = vi.fn(async () => ({ status: "sent" as const, id: "re" }));
    const d: FlowRunDeps = {
      now: NOW, mode: "live", takeover: { relance: new Date(NOW.getTime() - 3 * 86_400e3).toISOString() }, loadState: async () => null, saveState: async () => {},
      events: async (m) => (m === "Rycc4h" ? [c] : []), relay: relayView(null, null), relance1Sent: async () => true, flowSendingAgain: () => false,
      consentOf: async () => ({ consent: "NEVER_SUBSCRIBED", suppressed: false }), recipientAllowed: () => true, send, timeLeft: () => true,
      checkout2Yields: (e) => e.id === "c9",
    };
    // first run: state starts an hour ago, so give it a state that covers the checkout (kept between runs, so
    // reminder #1 is not resent and the follow-up spacing does not hold reminder #2 back behind it)
    let saved = emptyEngineState(new Date(NOW.getTime() - 3 * 86_400e3).toISOString());
    d.loadState = async () => saved;
    d.saveState = async (s) => { saved = JSON.parse(JSON.stringify(s)); };
    await runEmailFlows(d);
    const keys = () => send.mock.calls.map((x) => (x as unknown as [OutgoingEmail])[0].idemKey);
    expect(keys()).not.toContain("relance-2:c9");
    // without the 15 $ email owning it, the generic reminder #2 goes out
    send.mockClear();
    await runEmailFlows({ ...d, checkout2Yields: () => false });
    expect(keys()).toContain("relance-2:c9");
  });
});

describe("unsubscribes and consent reach Shopify", () => {
  const gqlFor = (nodes: unknown[], userErrors: unknown[] = []) => vi.fn(async (q: string, v?: Record<string, unknown>) => {
    void v;
    if (q.includes("consentFind")) return { data: { customers: { nodes } } };
    if (q.includes("consentUpdate")) return { data: { customerEmailMarketingConsentUpdate: { customer: { id: "gid://shopify/Customer/1" }, userErrors } } };
    return { data: { customerCreate: { customer: { id: "gid://shopify/Customer/2" }, userErrors } } };
  });

  it("an unsubscribe updates the existing customer and never creates one", async () => {
    const g = gqlFor([{ id: "gid://shopify/Customer/1", emailMarketingConsent: { marketingState: "SUBSCRIBED" } }]);
    expect(await setShopifyEmailConsent("A@x.ca", "UNSUBSCRIBED", { gql: g })).toBe("updated");
    expect(g.mock.calls[1][1]).toMatchObject({ input: { customerId: "gid://shopify/Customer/1", emailMarketingConsent: { marketingState: "UNSUBSCRIBED" } } });
    expect(await setShopifyEmailConsent("a@x.ca", "UNSUBSCRIBED", { gql: gqlFor([]) })).toBe("no-customer");
  });

  it("a subscribe creates the customer, but never re-subscribes someone who unsubscribed in Shopify", async () => {
    expect(await setShopifyEmailConsent("n@x.ca", "SUBSCRIBED", { gql: gqlFor([]), locale: "en" })).toBe("created");
    expect(await setShopifyEmailConsent("n@x.ca", "SUBSCRIBED", { gql: gqlFor([{ id: "1", emailMarketingConsent: { marketingState: "UNSUBSCRIBED" } }]) })).toBe("unchanged");
    await expect(setShopifyEmailConsent("n@x.ca", "UNSUBSCRIBED", { gql: gqlFor([{ id: "1", emailMarketingConsent: { marketingState: "SUBSCRIBED" } }], [{ message: "bad" }]) })).rejects.toBeInstanceOf(ShopifyConsentRefused);
  });

  it("DB: consent, unsubscribe, Shopify sync flags, outbox and the cap counter on the real schema", async () => {
    const db = await import("@/lib/database");
    await db.recordEmailConsent({ email: " Roue@X.ca ", source: "roue", locale: "fr" });
    expect(await db.getEmailConsent("roue@x.ca")).toEqual({ status: "subscribed", source: "roue", locale: "fr" });
    await db.suppressEmail({ email: "roue@x.ca", reason: "unsubscribe", source: "link" });
    await db.markEmailConsentUnsubscribed("roue@x.ca");
    await db.recordEmailConsent({ email: "roue@x.ca", source: "roue", locale: "en" }); // a new spin never undoes it
    expect((await db.getEmailConsent("roue@x.ca"))!.status).toBe("unsubscribed");
    expect(await db.listSuppressionsNotInShopify(10)).toEqual(["roue@x.ca"]);
    await db.markSuppressionInShopify("roue@x.ca");
    expect(await db.listSuppressionsNotInShopify(10)).toEqual([]);
    expect(await db.listConsentsNotInShopify(10)).toEqual([]);

    const now = Math.floor(Date.now() / 1000);
    expect(await db.enqueueEmail({ idemKey: "q1", priority: 3, notBefore: now - 10, expiresAt: now + 100, payload: "{}" })).toBe(true);
    expect(await db.enqueueEmail({ idemKey: "q1", priority: 3, notBefore: now - 10, expiresAt: now + 100, payload: "{}" })).toBe(false);
    await db.enqueueEmail({ idemKey: "q0", priority: 0, notBefore: now - 5, expiresAt: now + 100, payload: "{}" });
    await db.enqueueEmail({ idemKey: "later", priority: 0, notBefore: now + 3600, expiresAt: now + 7200, payload: "{}" });
    const due = await db.dueOutboxEmails(now, 10);
    expect(due.map((r) => r.idemKey)).toEqual(["q0", "q1"]);
    await db.finishOutboxEmail(due[0].id, "pending", "500");
    expect((await db.dueOutboxEmails(now, 10))[0].attempts).toBe(1);
    await db.finishOutboxEmail(due[0].id, "sent");
    expect(await db.countPendingOutbox()).toEqual({ "0": 1, "3": 1 });

    const before = await db.countEmailSendsSince(now - 86_400);
    const id = await db.reserveEmailSend({ idemKey: "cap-1", email: "a@x.ca", flow: "roue-1", kind: "marketing" });
    expect(await db.countEmailSendsSince(now - 86_400)).toBe(before + 1);
    await db.finishEmailSend(id!, { status: "failed", error: "x" });
    expect(await db.countEmailSendsSince(now - 86_400)).toBe(before);
  });

  it("DB: a wheel spin is read by the engine only when sent via Resend with the box ticked", async () => {
    const db = await import("@/lib/database");
    for (const [k, via, consent] of [["a@x.ca", "resend", true], ["b@x.ca", "klaviyo", true], ["c@x.ca", "resend", false]] as const) {
      await db.reserveWheelSpin({ emailKey: k, email: k, prizeKey: "15-150", ipHash: "h", locale: "fr" });
      await db.setWheelSpinCode(k, `ROUE-${k[0].toUpperCase()}23456`, "gid://d", 1_900_000_000);
      await db.setWheelSpinEmailVia(k, consent, via);
    }
    expect((await db.wheelSpinsForEngine(0)).map((r) => r.email)).toEqual(["a@x.ca"]);
  });
});

describe("Klaviyo headroom (scripts/klaviyo-headroom.mts)", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  const old = "2026-10-01T00:00:00Z";
  const c: HeadroomContext = { now, buyerIds: new Set(["b"]), shopifyBuyerEmails: new Set(["sb@x.ca"]), shopifySubscriberEmails: new Set(["ss@x.ca", "gone@x.ca"]), ongoingIds: new Set(["o"]), protectedEmails: new Set(["mat@x.ca"]) };
  const p = (id: string, email: string | null, over: Partial<Parameters<typeof classifyProfile>[0]> = {}) => ({ id, email, created: old, consent: "NEVER_SUBSCRIBED", suppressed: false, suppressedAt: [], ...over });

  it("only ever suppresses profiles that are neither buyers nor subscribers, old enough, with nothing in flight", () => {
    expect(classifyProfile(p("b", "b@x.ca"), c)).toBe("acheteur");
    expect(classifyProfile(p("x", "sb@x.ca"), c)).toBe("acheteur");
    expect(classifyProfile(p("x", "k@x.ca", { consent: "SUBSCRIBED" }), c)).toBe("abonne");
    expect(classifyProfile(p("x", "ss@x.ca"), c)).toBe("abonne");
    expect(classifyProfile(p("x", "n@x.ca", { created: "2026-11-20T00:00:00Z" }), c)).toBe("recent");
    expect(classifyProfile(p("x", "n@x.ca", { created: null }), c)).toBe("recent");
    expect(classifyProfile(p("o", "o@x.ca"), c)).toBe("relance-en-cours");
    expect(classifyProfile(p("x", "qa@ameublodirect.ca"), c)).toBe("interne");
    expect(classifyProfile(p("x", "Mat@x.ca"), c)).toBe("interne");
    expect(classifyProfile(p("x", null), c)).toBe("sans-courriel");
    expect(classifyProfile(p("x", "s@x.ca", { suppressed: true }), c)).toBe("deja-bloque");
    expect(classifyProfile(p("x", "idle@x.ca"), c)).toBe("a-bloquer");
  });

  it("reports counts, the blocked Shopify subscribers, and a reversible suppression job", () => {
    const r = buildReport([p("x", "idle@x.ca"), p("b", "b@x.ca"), p("g", "gone@x.ca", { suppressed: true, suppressedAt: ["2026-11-13T15:00:00Z"] })], c);
    expect(r).toMatchObject({ total: 3, active: 2, activeAfter: 1, candidates: [{ id: "x", email: "idle@x.ca" }], shopifySubscribersBlocked: { total: 1, on20261113: 1 } });
    expect(suppressionJob(["a@x.ca"]).data.type).toBe("profile-suppression-bulk-create-job");
    expect(suppressionJob(["a@x.ca"], true).data.type).toBe("profile-suppression-bulk-delete-job");
  });
});

describe("relay emails rendered for Resend", () => {
  const ev: CheckoutEvent = { eventId: "e1", profileId: "p1", email: "c@x.ca", at: "2026-12-01T00:00:00Z", locale: "fr", recoverUrl: "https://ameublodirect.ca/checkouts/abc", value: 300, subtotal: 280, discounts: 0, items: [{ title: "Lit <double>", quantity: 1, price: 280, image: null, handle: null }] };

  it("checkout reminder #2 with code: code, expiry and the escaped recover link, no Klaviyo tags", () => {
    const m = relance2Email(ev, { code: "RELANCE15-ABCDEFGHJK", discountId: "d", endsAt: "2026-12-03T00:00:00Z", at: "t" }, "<tr><td>Lit &lt;double&gt;</td></tr>")!;
    expect(m.subject).toBe("15 $ de rabais pour terminer ta commande");
    expect(m.bodyHtml).toContain("RELANCE15-ABCDEFGHJK");
    expect(m.bodyHtml).toContain("https://ameublodirect.ca/checkouts/abc");
    expect(m.bodyHtml + m.bodyText).not.toMatch(/\{\{|\{%/);
    expect(relance2Email({ ...ev, recoverUrl: null }, { code: "X", discountId: "d", endsAt: "2026-12-03T00:00:00Z", at: "t" }, "")).toBeNull();
  });

  it("cart reminder: items, link, no Klaviyo tags", () => {
    const m = cartEmail({ cartId: "c", eventIds: ["a"], profileId: "p", email: "c@x.ca", firstAt: "t", at: "t", locale: "en", url: "https://ameublodirect.ca/cart", items: [{ title: "Sofa", quantity: 2, price: 100, image: null, url: null, variantId: "1" }] }, new Date("2026-12-10T12:00:00Z"));
    expect(m.subject).toBe("You left something in your cart 🛒");
    expect(m.bodyHtml).toContain("https://ameublodirect.ca/cart");
    expect(m.bodyHtml + m.bodyText).not.toMatch(/\{\{|\{%/);
  });
});
