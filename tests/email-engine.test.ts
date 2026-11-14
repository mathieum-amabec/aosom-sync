/**
 * Own email engine (Resend): transport, signed unsubscribe links, CASL footer, the send gates
 * (off / test / suppressed / duplicate / not configured), Svix webhook signatures, and the SQL
 * against the real schema in an in-memory libsql DB.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

import { sendViaResend, toResendBody } from "@/lib/email/resend";
import { emailKey, unsubscribeUrl, verifyUnsubscribe, tokenSecret } from "@/lib/email/unsubscribe";
import { renderLayout, button } from "@/lib/email/layout";
import { buildEmail, configProblems, parseMode, parseRecipients, sendEmail, type EngineConfig, type EngineDeps, type OutgoingEmail } from "@/lib/email/engine";
import { verifySvix, webhookAction } from "@/lib/email/webhook";

const SECRET = "s".repeat(40);

const cfg = (over: Partial<EngineConfig> = {}): EngineConfig => ({
  mode: "live",
  testRecipients: new Set(),
  mailingAddress: "C.P. 123, Saint-Hubert QC J3Y 0A1",
  from: "Ameublo Direct <bonjour@ameublodirect.ca>",
  replyTo: "",
  apiKey: "re_test",
  tokenSecret: SECRET,
  baseUrl: "https://app.example.ca",
  ...over,
});

const msg = (over: Partial<OutgoingEmail> = {}): OutgoingEmail => ({
  to: "Client@Example.com",
  flow: "relance-1",
  idemKey: "relance-1:ev1",
  kind: "marketing",
  locale: "fr",
  subject: "Ton panier t'attend",
  preheader: "Tes articles sont encore là",
  bodyHtml: "<p>Bonjour</p>",
  bodyText: "Bonjour",
  ...over,
});

function deps(over: Partial<EngineDeps> = {}): EngineDeps & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    isSuppressed: vi.fn().mockResolvedValue(false),
    reserve: vi.fn().mockResolvedValue(1),
    finish: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (e) => { sent.push(e); return { ok: true as const, id: "re_1" }; }),
    ...over,
  };
}

describe("resend client", () => {
  it("builds the API body: array recipient, reply_to, sanitized tags", () => {
    const b = toResendBody({ from: "a@b.ca", to: "c@d.ca", subject: "s", html: "<p>", text: "t", replyTo: "r@b.ca", tags: { flow: "relance 1é", kind: "marketing" } });
    expect(b).toMatchObject({ to: ["c@d.ca"], reply_to: "r@b.ca", tags: [{ name: "flow", value: "relance_1_" }, { name: "kind", value: "marketing" }] });
  });

  it("sends the idempotency key and retries once on 429", async () => {
    const calls: RequestInit[] = [];
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      calls.push(init);
      return calls.length === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "1" } }) : Response.json({ id: "re_9" });
    });
    const r = await sendViaResend({ from: "a@b.ca", to: "c@d.ca", subject: "s", html: "h", text: "t" }, "k1", { apiKey: "re_x", fetchImpl: f as unknown as typeof fetch, sleep: async () => {} });
    expect(r).toEqual({ ok: true, id: "re_9" });
    expect(calls).toHaveLength(2);
    expect((calls[0].headers as Record<string, string>)["Idempotency-Key"]).toBe("k1");
  });

  it("reports API errors, retryable only for 429/5xx", async () => {
    const f = vi.fn(async () => Response.json({ name: "validation_error", message: "bad from" }, { status: 422 }));
    const r = await sendViaResend({ from: "x", to: "c@d.ca", subject: "s", html: "h", text: "t" }, "k", { apiKey: "k", fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ ok: false, status: 422, error: "validation_error: bad from", retryable: false });
  });
});

describe("unsubscribe links", () => {
  it("round-trips, case-insensitively, and rejects tampering", () => {
    const url = new URL(unsubscribeUrl("https://app.example.ca/", "Jo@Example.com", SECRET));
    expect(url.pathname).toBe("/api/email/unsubscribe");
    const e = url.searchParams.get("e"), t = url.searchParams.get("t");
    expect(verifyUnsubscribe(e, t, SECRET)).toBe("jo@example.com");
    expect(verifyUnsubscribe(e, t, "x".repeat(40))).toBeNull();
    const other = new URL(unsubscribeUrl("https://app.example.ca", "someone@else.ca", SECRET)).searchParams.get("e");
    expect(verifyUnsubscribe(other, t, SECRET)).toBeNull();
    expect(verifyUnsubscribe(null, t, SECRET)).toBeNull();
  });

  it("needs a secret of 32+ chars", () => {
    expect(tokenSecret({ EMAIL_TOKEN_SECRET: "short" })).toBeNull();
    expect(tokenSecret({ EMAIL_TOKEN_SECRET: SECRET })).toBe(SECRET);
    expect(emailKey("  A@B.CA ")).toBe("a@b.ca");
  });
});

describe("layout", () => {
  it("always carries the CASL footer in HTML and text, escaped", () => {
    const { html, text } = renderLayout({ locale: "en", preheader: "<hi>", bodyHtml: "<p>x</p>", bodyText: "x", mailingAddress: "PO Box 1 & co", unsubscribeUrl: "https://u.ca/?a=1&b=2" });
    expect(html).toContain("Furnish Direct · PO Box 1 &amp; co");
    expect(html).toContain('href="https://u.ca/?a=1&amp;b=2"');
    expect(html).toContain("&lt;hi&gt;");
    expect(text).toContain("Unsubscribe : https://u.ca/?a=1&b=2");
    expect(button("https://x.ca", "Go")).toContain("https://x.ca");
  });
});

describe("engine gates", () => {
  it("parses mode and test recipients safely", () => {
    expect(parseMode(null)).toBe("off");
    expect(parseMode("LIVE")).toBe("off");
    expect(parseMode("test")).toBe("test");
    expect([...parseRecipients(" A@b.ca, c@d.ca;nope ")]).toEqual(["a@b.ca", "c@d.ca"]);
  });

  it("names every missing piece of configuration", () => {
    expect(configProblems(cfg())).toEqual([]);
    expect(configProblems(cfg({ apiKey: "", from: "nope", tokenSecret: "", baseUrl: "", mailingAddress: "" }))).toHaveLength(5);
  });

  it("off sends nothing and touches nothing", async () => {
    const d = deps();
    expect(await sendEmail(msg(), cfg({ mode: "off" }), d)).toEqual({ status: "skipped", reason: "off" });
    expect(d.reserve).not.toHaveBeenCalled();
  });

  it("test mode only mails the allow-listed addresses", async () => {
    const d = deps();
    const c = cfg({ mode: "test", testRecipients: parseRecipients("mat@ameublo.ca") });
    expect(await sendEmail(msg(), c, d)).toMatchObject({ status: "skipped", reason: "not-test-recipient" });
    expect(await sendEmail(msg({ to: "Mat@Ameublo.ca" }), c, d)).toMatchObject({ status: "sent" });
  });

  it("refuses to send without the mailing address (CASL)", async () => {
    const d = deps();
    const r = await sendEmail(msg(), cfg({ mailingAddress: "" }), d);
    expect(r).toMatchObject({ status: "skipped", reason: "not-configured" });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("skips suppressed addresses for marketing only", async () => {
    const d = deps({ isSuppressed: vi.fn().mockResolvedValue(true) });
    expect(await sendEmail(msg(), cfg(), d)).toMatchObject({ reason: "suppressed" });
    expect(await sendEmail(msg({ kind: "transactional" }), cfg(), d)).toMatchObject({ status: "sent" });
  });

  it("never sends a claimed key twice", async () => {
    const d = deps({ reserve: vi.fn().mockResolvedValue(null) });
    expect(await sendEmail(msg(), cfg(), d)).toMatchObject({ reason: "duplicate" });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("sends with one-click unsubscribe headers and records the Resend id", async () => {
    const d = deps();
    expect(await sendEmail(msg(), cfg(), d)).toEqual({ status: "sent", id: "re_1" });
    const e = d.sent[0] as ReturnType<typeof buildEmail>;
    expect(e.to).toBe("Client@Example.com");
    expect(e.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(e.headers!["List-Unsubscribe"]).toMatch(/^<https:\/\/app\.example\.ca\/api\/email\/unsubscribe\?e=.+&t=.+>$/);
    expect(e.html).toContain("C.P. 123, Saint-Hubert QC");
    expect(d.finish).toHaveBeenCalledWith(1, { status: "sent", resendId: "re_1" });
  });

  it("records a failure (and a thrown transport error) as failed", async () => {
    const d = deps({ send: vi.fn().mockRejectedValue(new Error("boom")) });
    expect(await sendEmail(msg(), cfg(), d)).toEqual({ status: "failed", error: "boom", retryable: true });
    expect(d.finish).toHaveBeenCalledWith(1, { status: "failed", error: "boom" });
  });
});

describe("Resend webhook", () => {
  const key = crypto.randomBytes(24);
  const secret = "whsec_" + key.toString("base64");
  const sign = (body: string, id: string, ts: string) => "v1," + crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");

  it("accepts a valid Svix signature, rejects tampering and stale timestamps", () => {
    const now = 1_800_000_000, ts = String(now), body = '{"type":"email.delivered"}';
    const h = { id: "msg_1", timestamp: ts, signature: `v1,bogus ${sign(body, "msg_1", ts)}` };
    expect(verifySvix(body, h, secret, now)).toBe(true);
    expect(verifySvix(body + " ", h, secret, now)).toBe(false);
    expect(verifySvix(body, h, secret, now + 600)).toBe(false);
    expect(verifySvix(body, { ...h, signature: null }, secret, now)).toBe(false);
  });

  it("suppresses hard bounces and complaints, not temporary bounces", () => {
    expect(webhookAction({ type: "email.complained", data: { email_id: "re_1", to: ["a@b.ca"] } })).toEqual({
      suppress: { emails: ["a@b.ca"], reason: "complaint", detail: "spam complaint" }, status: { resendId: "re_1", status: "complained" },
    });
    expect(webhookAction({ type: "email.bounced", data: { email_id: "re_2", to: ["a@b.ca"], bounce: { type: "Permanent", subType: "General" } } }).suppress?.reason).toBe("bounce");
    expect(webhookAction({ type: "email.bounced", data: { to: ["a@b.ca"], bounce: { type: "Transient" } } }).suppress).toBeNull();
    expect(webhookAction({ type: "email.bounced", data: { to: ["a@b.ca"], bounce: { type: "Undetermined" } } }).suppress).toBeNull();
    expect(webhookAction({ type: "email.sent", data: { email_id: "re_3" } })).toEqual({ suppress: null, status: null });
  });
});

describe("email tables (real schema)", () => {
  let db: typeof import("@/lib/database");
  beforeAll(async () => {
    db = await import("@/lib/database");
    await db.ensureSchema();
  });

  it("suppression is case-insensitive and keeps the first reason", async () => {
    await db.suppressEmail({ email: " X@Y.ca", reason: "unsubscribe", source: "link" });
    await db.suppressEmail({ email: "x@y.ca", reason: "bounce", source: "resend-webhook" });
    expect(await db.isEmailSuppressed("x@y.CA")).toBe(true);
    expect(await db.isEmailSuppressed("z@y.ca")).toBe(false);
    const c = await db.ensureSchema();
    expect((await c.execute("SELECT reason FROM email_suppressions WHERE email = 'x@y.ca'")).rows[0].reason).toBe("unsubscribe");
  });

  it("lets only one of many parallel runs claim a key, and a failed send be retried", async () => {
    const s = { idemKey: "relance-1:evA", email: "a@b.ca", flow: "relance-1", kind: "marketing" };
    const ids = await Promise.all(Array.from({ length: 8 }, () => db.reserveEmailSend(s)));
    const won = ids.filter((x) => x != null);
    expect(won).toHaveLength(1);
    await db.finishEmailSend(won[0]!, { status: "failed", error: "500" });
    const again = await db.reserveEmailSend(s);
    expect(again).toBe(won[0]);
    await db.finishEmailSend(again!, { status: "sent", resendId: "re_A" });
    expect(await db.reserveEmailSend(s)).toBeNull();
  });

  it("unsubscribe route: GET only asks, POST (button or one-click) unsubscribes, forged links do nothing", async () => {
    process.env.EMAIL_TOKEN_SECRET = SECRET;
    const route = await import("@/app/api/email/unsubscribe/route");
    const url = unsubscribeUrl("https://app.example.ca", "Route@Test.ca", SECRET);
    const get = await route.GET(new Request(url));
    expect(get.status).toBe(200);
    expect(await get.text()).toContain("route@test.ca");
    expect(await db.isEmailSuppressed("route@test.ca")).toBe(false);
    const post = await route.POST(new Request(url, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
    expect(post.status).toBe(200);
    expect(await db.isEmailSuppressed("route@test.ca")).toBe(true);
    const forged = await route.POST(new Request(url.replace(/t=[^&]+/, "t=AAAA"), { method: "POST" }));
    expect(forged.status).toBe(400);
  });

  it("a send cut off mid-way ('sending' for 10+ min) can be claimed again; a fresh one cannot", async () => {
    const s = { idemKey: "roue-1:stuck", email: "s@b.ca", flow: "roue-1", kind: "marketing" };
    const id = await db.reserveEmailSend(s);
    expect(await db.reserveEmailSend(s)).toBeNull();
    const c = await db.ensureSchema();
    await c.execute({ sql: "UPDATE email_sends SET updated_at = updated_at - 700 WHERE id = ?", args: [id!] });
    expect(await db.reserveEmailSend(s)).toBe(id);
  });

  it("tracks which suppressions still have to reach Klaviyo", async () => {
    await db.suppressEmail({ email: "k@y.ca", reason: "bounce", source: "resend-webhook" });
    expect(await db.listSuppressionsNotInKlaviyo(100)).toContain("k@y.ca");
    await db.markSuppressionInKlaviyo("K@y.ca");
    expect(await db.listSuppressionsNotInKlaviyo(100)).not.toContain("k@y.ca");
  });

  it("webhook statuses only move forward", async () => {
    const id = await db.reserveEmailSend({ idemKey: "k:B", email: "b@b.ca", flow: "bienvenue-1", kind: "marketing" });
    await db.finishEmailSend(id!, { status: "sent", resendId: "re_B" });
    expect(await db.updateEmailSendStatus("re_B", "opened")).toBe(true);
    expect(await db.updateEmailSendStatus("re_B", "delivered")).toBe(false);
    expect(await db.updateEmailSendStatus("re_unknown", "opened")).toBe(false);
    const stats = await db.getEmailSendStats(0);
    expect(stats).toContainEqual({ flow: "bienvenue-1", status: "opened", n: 1 });
  });
});
