import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assistantDailyToken,
  verifyAssistantToken,
  ASSISTANT_TOKEN_HEADER,
} from "@/lib/assistant-auth";
import { limitPayload, MAX_MESSAGES_PER_HOUR } from "@/lib/assistant-limits";

/**
 * CSO finding 2: /api/assistant gated only on a spoofable Origin header, and its daily
 * token pool was reaching its cap on most days — which surfaced to the shopper as a 500
 * and the widget's generic "une erreur est survenue".
 */

const SECRET = "test-secret-do-not-use-in-prod";

describe("assistantDailyToken", () => {
  it("is stable for a given UTC day", () => {
    const a = assistantDailyToken(SECRET, new Date("2026-09-01T00:00:01Z"));
    const b = assistantDailyToken(SECRET, new Date("2026-09-01T23:59:59Z"));
    expect(a).toBe(b);
  });

  it("changes when the day changes", () => {
    const d1 = assistantDailyToken(SECRET, new Date("2026-09-01T12:00:00Z"));
    const d2 = assistantDailyToken(SECRET, new Date("2026-09-02T12:00:00Z"));
    expect(d1).not.toBe(d2);
  });

  it("changes when the secret changes — rotation revokes every scraped copy", () => {
    const day = new Date("2026-09-01T12:00:00Z");
    expect(assistantDailyToken(SECRET, day)).not.toBe(assistantDailyToken("other-secret", day));
  });

  it("is 32 hex chars", () => {
    expect(assistantDailyToken(SECRET)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("never contains the secret", () => {
    expect(assistantDailyToken(SECRET)).not.toContain(SECRET);
  });
});

describe("verifyAssistantToken", () => {
  const ORIGINAL = process.env.ASSISTANT_SECRET;
  beforeEach(() => { process.env.ASSISTANT_SECRET = SECRET; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ASSISTANT_SECRET;
    else process.env.ASSISTANT_SECRET = ORIGINAL;
  });

  const now = new Date("2026-09-02T10:00:00Z");

  it("accepts today's token", () => {
    expect(verifyAssistantToken(assistantDailyToken(SECRET, now), now)).toBe("ok");
  });

  it("accepts yesterday's token — a page loaded before midnight must not break", () => {
    const yest = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    expect(verifyAssistantToken(assistantDailyToken(SECRET, yest), now)).toBe("ok");
  });

  it("rejects a token from two days ago", () => {
    const old = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    expect(verifyAssistantToken(assistantDailyToken(SECRET, old), now)).toBe("invalid");
  });

  it("rejects a token minted with a different secret", () => {
    expect(verifyAssistantToken(assistantDailyToken("attacker-guess", now), now)).toBe("invalid");
  });

  it("reports a missing header separately from a wrong one", () => {
    expect(verifyAssistantToken(null, now)).toBe("missing");
    expect(verifyAssistantToken("", now)).toBe("missing");
    expect(verifyAssistantToken("deadbeef", now)).toBe("invalid");
  });

  it("does not throw on a wrong-length header (timingSafeEqual would)", () => {
    expect(() => verifyAssistantToken("short", now)).not.toThrow();
    expect(verifyAssistantToken("x".repeat(500), now)).toBe("invalid");
  });

  it("returns not_configured when the secret is unset — the rollout grace path", () => {
    // This is what keeps the deployed widget (which sends no custom header) alive between
    // shipping the route and updating the theme. If this ever returns anything else, the
    // storefront assistant goes dark on deploy.
    delete process.env.ASSISTANT_SECRET;
    expect(verifyAssistantToken(null, now)).toBe("not_configured");
    expect(verifyAssistantToken("anything", now)).toBe("not_configured");
  });

  it("exports the header name in the lowercase form Request.headers.get expects", () => {
    expect(ASSISTANT_TOKEN_HEADER).toBe("x-assistant-token");
  });
});

describe("limitPayload — shopper-facing copy", () => {
  it("tells the shopper WHEN to come back on an hourly-quota trip (FR)", () => {
    const p = limitPayload("fr", "hourly_quota", 12 * 60);
    expect(p.message).toBe("Trop de requêtes. Réessayez dans environ 12 minutes.");
    expect(p.retryAfter).toBe(720);
  });

  it("same in EN", () => {
    expect(limitPayload("en", "hourly_quota", 12 * 60).message)
      .toBe("Too many requests. Please try again in about 12 minutes.");
  });

  it("rounds up and never says 'in 0 minutes'", () => {
    expect(limitPayload("fr", "hourly_quota", 5).message).toContain("une minute");
    expect(limitPayload("en", "hourly_quota", 5).message).toContain("a minute");
  });

  it("gives a graceful message when the daily pool is exhausted, not an error (FR + EN)", () => {
    expect(limitPayload("fr", "budget_exhausted", 0).message)
      .toBe("Notre assistant est temporairement indisponible. Écrivez-nous à info@ameublodirect.ca 😊");
    expect(limitPayload("en", "budget_exhausted", 0).message)
      .toBe("Our assistant is temporarily unavailable. Email us at info@ameublodirect.ca 😊");
  });

  it("does not append the generic contact tail to the self-contained budget copy", () => {
    // The budget copy names the address itself; appending REACH_US would print the email
    // twice in one bubble ("… à info@… 😊 Écrivez-nous : info@…").
    for (const locale of ["fr", "en"] as const) {
      const p = limitPayload(locale, "budget_exhausted", 0);
      expect(p.reply).toBe(p.message);
      expect(p.reply.match(/info@ameublodirect\.ca/g)).toHaveLength(1);
    }
  });

  it("still offers WhatsApp on the budget path when a number is configured", () => {
    // Skipping REACH_US must not cost this path the WhatsApp channel every other reason
    // keeps — it is the most common limit path, so losing it there loses it in practice.
    const prev = process.env.ASSISTANT_CONTACT_WHATSAPP;
    process.env.ASSISTANT_CONTACT_WHATSAPP = "15145550123";
    try {
      const p = limitPayload("fr", "budget_exhausted", 0);
      expect(p.contact.whatsappUrl).toBe("https://wa.me/15145550123");
      expect(p.reply).toContain("https://wa.me/15145550123");
      // `message` stays the operator-specified sentence, verbatim.
      expect(p.message).toBe(
        "Notre assistant est temporairement indisponible. Écrivez-nous à info@ameublodirect.ca 😊",
      );
      expect(p.reply.match(/info@ameublodirect\.ca/g)).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.ASSISTANT_CONTACT_WHATSAPP;
      else process.env.ASSISTANT_CONTACT_WHATSAPP = prev;
    }
  });

  it("always hands the shopper a way to reach a human", () => {
    for (const reason of ["hourly_quota", "consecutive_messages", "budget_exhausted"] as const) {
      for (const locale of ["fr", "en"] as const) {
        const p = limitPayload(locale, reason, 60);
        expect(p.contact.email).toMatch(/@/);
        expect(p.reply).toContain(p.contact.email);
      }
    }
  });

  it("keeps the shape the DEPLOYED widget renders (reply + products)", () => {
    // The theme snippet reads exactly j.data.reply and j.data.products, with textContent.
    // Drop either and the shopper gets a blank bubble.
    const p = limitPayload("fr", "budget_exhausted", 0);
    expect(typeof p.reply).toBe("string");
    expect(p.reply.length).toBeGreaterThan(0);
    expect(Array.isArray(p.products)).toBe(true);
  });
});

describe("the hourly quota is the shared one", () => {
  it("is 20 per rolling hour", () => {
    expect(MAX_MESSAGES_PER_HOUR).toBe(20);
  });
});

/* ── route behaviour ─────────────────────────────────────────────────────────── */

const ORIGIN = "https://ameublodirect.ca";

function post(headers: Record<string, string> = {}, body: unknown = { message: "un canapé", locale: "fr" }): Request {
  return new Request("https://aosom-sync.vercel.app/api/assistant", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/assistant — token gate", () => {
  const ORIGINAL = process.env.ASSISTANT_SECRET;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ASSISTANT_SECRET;
    else process.env.ASSISTANT_SECRET = ORIGINAL;
  });

  it("403s a spoofed-Origin caller that has no token, once the secret is configured", async () => {
    process.env.ASSISTANT_SECRET = SECRET;
    vi.doMock("@/lib/assistant", () => ({ runAssistant: vi.fn(), runComplementary: vi.fn() }));
    vi.doMock("@/lib/database", () => ({
      countAssistantRequests: vi.fn().mockResolvedValue(0),
      recordAssistantRequest: vi.fn(),
      secondsUntilAssistantSlot: vi.fn().mockResolvedValue(3600),
    }));
    const { POST } = await import("@/app/api/assistant/route");
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden_token");
  });

  it("lets a correctly-tokened caller through", async () => {
    process.env.ASSISTANT_SECRET = SECRET;
    vi.doMock("@/lib/assistant", () => ({
      runAssistant: vi.fn().mockResolvedValue({ reply: "Voici quelques options.", products: [] }),
      runComplementary: vi.fn(),
    }));
    vi.doMock("@/lib/database", () => ({
      countAssistantRequests: vi.fn().mockResolvedValue(0),
      recordAssistantRequest: vi.fn().mockResolvedValue(undefined),
      secondsUntilAssistantSlot: vi.fn().mockResolvedValue(3600),
    }));
    const { POST } = await import("@/app/api/assistant/route");
    const res = await POST(post({ "X-Assistant-Token": assistantDailyToken(SECRET) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.reply).toBe("Voici quelques options.");
  });

  it("stays OPEN while ASSISTANT_SECRET is unset — the deployed widget keeps working", async () => {
    delete process.env.ASSISTANT_SECRET;
    vi.doMock("@/lib/assistant", () => ({
      runAssistant: vi.fn().mockResolvedValue({ reply: "ok", products: [] }),
      runComplementary: vi.fn(),
    }));
    vi.doMock("@/lib/database", () => ({
      countAssistantRequests: vi.fn().mockResolvedValue(0),
      recordAssistantRequest: vi.fn().mockResolvedValue(undefined),
      secondsUntilAssistantSlot: vi.fn().mockResolvedValue(3600),
    }));
    const { POST } = await import("@/app/api/assistant/route");
    const res = await POST(post()); // no token header, exactly like the live widget
    expect(res.status).toBe(200);
  });

  it("still rejects a foreign Origin even with a valid token", async () => {
    process.env.ASSISTANT_SECRET = SECRET;
    vi.doMock("@/lib/assistant", () => ({ runAssistant: vi.fn(), runComplementary: vi.fn() }));
    vi.doMock("@/lib/database", () => ({
      countAssistantRequests: vi.fn().mockResolvedValue(0),
      recordAssistantRequest: vi.fn(),
      secondsUntilAssistantSlot: vi.fn().mockResolvedValue(3600),
    }));
    const { POST } = await import("@/app/api/assistant/route");
    const req = new Request("https://aosom-sync.vercel.app/api/assistant", {
      method: "POST",
      headers: {
        Origin: "https://evil.example.com",
        "Content-Type": "application/json",
        "X-Assistant-Token": assistantDailyToken(SECRET),
      },
      body: JSON.stringify({ message: "hi", locale: "fr" }),
    });
    expect((await POST(req)).status).toBe(403);
  });
});

describe("POST /api/assistant — quota and budget responses", () => {
  beforeEach(() => { vi.resetModules(); delete process.env.ASSISTANT_SECRET; });

  it("429s over quota, and the body still carries the reply the widget renders", async () => {
    vi.doMock("@/lib/assistant", () => ({ runAssistant: vi.fn(), runComplementary: vi.fn() }));
    vi.doMock("@/lib/database", () => ({
      countAssistantRequests: vi.fn().mockResolvedValue(MAX_MESSAGES_PER_HOUR),
      recordAssistantRequest: vi.fn(),
      secondsUntilAssistantSlot: vi.fn().mockResolvedValue(15 * 60),
    }));
    const { POST } = await import("@/app/api/assistant/route");
    const res = await POST(post());
    expect(res.status).toBe(429);
    const body = await res.json();
    // success:true on a 429 is deliberate — the widget ignores the status and only renders
    // when j.success is true. See the comment in the route.
    expect(body.success).toBe(true);
    expect(body.data.reason).toBe("hourly_quota");
    expect(body.data.reply).toContain("15 minutes");
  });

  it("does not spend a Claude call when over quota", async () => {
    const runAssistant = vi.fn();
    vi.doMock("@/lib/assistant", () => ({ runAssistant, runComplementary: vi.fn() }));
    vi.doMock("@/lib/database", () => ({
      countAssistantRequests: vi.fn().mockResolvedValue(MAX_MESSAGES_PER_HOUR + 5),
      recordAssistantRequest: vi.fn(),
      secondsUntilAssistantSlot: vi.fn().mockResolvedValue(60),
    }));
    const { POST } = await import("@/app/api/assistant/route");
    await POST(post());
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it("serves the hand-off card as a 200 when the daily pool is exhausted", async () => {
    const { LlmBudgetExceededError } = await import("@/lib/llm-budget");
    vi.doMock("@/lib/assistant", () => ({
      runAssistant: vi.fn().mockRejectedValue(new LlmBudgetExceededError("assistant", 500_000, 500_000)),
      runComplementary: vi.fn(),
    }));
    vi.doMock("@/lib/database", () => ({
      countAssistantRequests: vi.fn().mockResolvedValue(0),
      recordAssistantRequest: vi.fn(),
      secondsUntilAssistantSlot: vi.fn().mockResolvedValue(3600),
    }));
    const { POST } = await import("@/app/api/assistant/route");
    const res = await POST(post());
    // 200, never 503: a spent daily pool is our rationing decision, not a service fault,
    // and the shopper is handed a real next step. A 503 also hid the card from any client
    // that checks res.ok before reading the body.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.limitReached).toBe(true);
    expect(body.data.reason).toBe("budget_exhausted");
    expect(body.data.message).toContain("temporairement indisponible");
    expect(body.data.reply).toContain("temporairement indisponible");
    expect(body.data.reply).toMatch(/@/); // contact route out
  });

  it("still 500s on a genuine fault — the budget path must not swallow real errors", async () => {
    vi.doMock("@/lib/assistant", () => ({
      runAssistant: vi.fn().mockRejectedValue(new Error("Anthropic exploded")),
      runComplementary: vi.fn(),
    }));
    vi.doMock("@/lib/database", () => ({
      countAssistantRequests: vi.fn().mockResolvedValue(0),
      recordAssistantRequest: vi.fn(),
      secondsUntilAssistantSlot: vi.fn().mockResolvedValue(3600),
    }));
    const { POST } = await import("@/app/api/assistant/route");
    const res = await POST(post());
    expect(res.status).toBe(500);
    expect((await res.json()).success).toBe(false);
  });

  it("advertises X-Assistant-Token in the CORS preflight, or the browser drops the header", async () => {
    vi.doMock("@/lib/assistant", () => ({ runAssistant: vi.fn(), runComplementary: vi.fn() }));
    vi.doMock("@/lib/database", () => ({
      countAssistantRequests: vi.fn(), recordAssistantRequest: vi.fn(), secondsUntilAssistantSlot: vi.fn(),
    }));
    const { OPTIONS } = await import("@/app/api/assistant/route");
    const res = OPTIONS(new Request("https://aosom-sync.vercel.app/api/assistant", {
      method: "OPTIONS", headers: { Origin: ORIGIN },
    }));
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Assistant-Token");
  });
});
