import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AssistantTurn } from "@/lib/assistant";
import {
  trailingUserTurns,
  isRapidFire,
  limitPayload,
  contactChannels,
  MAX_CONSECUTIVE_USER_TURNS,
  MAX_MESSAGES_PER_HOUR,
} from "@/lib/assistant-limits";

const u = (content = "?"): AssistantTurn => ({ role: "user", content });
const a = (content = "!"): AssistantTurn => ({ role: "assistant", content });

describe("trailingUserTurns", () => {
  it("counts only the unanswered run at the end of the history", () => {
    expect(trailingUserTurns([])).toBe(0);
    expect(trailingUserTurns([u(), a()])).toBe(0);
    expect(trailingUserTurns([u(), a(), u()])).toBe(1);
    expect(trailingUserTurns([a(), u(), u()])).toBe(2);
  });

  it("does not count earlier unanswered runs once an assistant turn follows them", () => {
    expect(trailingUserTurns([u(), u(), u(), a()])).toBe(0);
  });
});

describe("isRapidFire", () => {
  it("allows a normal alternating conversation", () => {
    expect(isRapidFire([])).toBe(false);
    expect(isRapidFire([u(), a(), u(), a()])).toBe(false);
  });

  it("allows the shopper to double-message without being cut off", () => {
    // One unanswered turn + this request = 2 consecutive, under the allowance.
    expect(isRapidFire([a(), u()])).toBe(false);
  });

  it("trips when this request would be the 4th consecutive shopper turn", () => {
    expect(isRapidFire([a(), u(), u()])).toBe(false); // this makes 3 — still allowed
    expect(isRapidFire([a(), u(), u(), u()])).toBe(true); // this would make 4
  });

  it("agrees with the documented allowance", () => {
    const history = Array.from({ length: MAX_CONSECUTIVE_USER_TURNS }, () => u());
    expect(isRapidFire(history)).toBe(true);
  });

  it("recovers after the assistant answers — a blocked shopper is never stuck", () => {
    // The deployed widget pushes every bot reply (the limit notice included) into history,
    // so the unanswered run resets and the shopper can keep talking.
    expect(isRapidFire([u(), u(), u(), a()])).toBe(false);
  });
});

describe("limitPayload", () => {
  const ENV = process.env.ASSISTANT_CONTACT_WHATSAPP;
  beforeEach(() => { delete process.env.ASSISTANT_CONTACT_WHATSAPP; });
  afterEach(() => { if (ENV === undefined) delete process.env.ASSISTANT_CONTACT_WHATSAPP; else process.env.ASSISTANT_CONTACT_WHATSAPP = ENV; });

  // The hourly-quota copy changed in v0.5.71.0: it now names the wait instead of only
  // saying no. The "limite de questions" wording moved to the rapid-fire hand-off, which is
  // terminal for this visit and has no retry time to quote.
  it("carries the exact French copy", () => {
    const p = limitPayload("fr", "consecutive_messages", 60);
    expect(p.message).toBe(
      "Vous avez atteint la limite de questions. Notre équipe peut vous aider directement 😊",
    );
  });

  it("carries the exact English copy", () => {
    const p = limitPayload("en", "consecutive_messages", 60);
    expect(p.message).toBe("You've reached the question limit. Our team can help you directly 😊");
  });

  it("names the wait on an hourly-quota trip, in both locales", () => {
    expect(limitPayload("fr", "hourly_quota", 3600).message)
      .toBe("Trop de requêtes. Réessayez dans environ 60 minutes.");
    expect(limitPayload("en", "hourly_quota", 3600).message)
      .toBe("Too many requests. Please try again in about 60 minutes.");
  });

  it("renders in the deployed widget: it has reply + products", () => {
    // The theme snippet does `j.data.reply || ''` then `addCards(j.data.products)`.
    // Without these the shopper gets a blank bubble.
    const p = limitPayload("fr", "hourly_quota", 3600);
    expect(typeof p.reply).toBe("string");
    expect(p.reply.length).toBeGreaterThan(0);
    expect(Array.isArray(p.products)).toBe(true);
  });

  it("spells the address out in reply, because the widget uses textContent", () => {
    const p = limitPayload("en", "hourly_quota", 3600);
    expect(p.reply).toContain(contactChannels().email);
    expect(p.reply).toContain(p.message);
  });

  it("omits WhatsApp entirely when no number is configured", () => {
    const p = limitPayload("fr", "hourly_quota", 3600);
    expect(p.contact.whatsappUrl).toBeNull();
    expect(p.reply).not.toContain("wa.me");
  });

  it("includes a wa.me link when a number IS configured, digits only", () => {
    process.env.ASSISTANT_CONTACT_WHATSAPP = "+1 (514) 555-0123";
    const p = limitPayload("fr", "hourly_quota", 3600);
    expect(p.contact.whatsappUrl).toBe("https://wa.me/15145550123");
    expect(p.reply).toContain("https://wa.me/15145550123");
  });

  it("builds a mailto with a localized subject", () => {
    expect(limitPayload("fr", "hourly_quota", 3600).contact.emailUrl).toContain("Aide%20pour%20ma%20commande");
    expect(limitPayload("en", "hourly_quota", 3600).contact.emailUrl).toContain("Help%20with%20my%20order");
  });

  it("does not leak the personal address used on the privacy page", () => {
    expect(limitPayload("fr", "hourly_quota", 3600).reply).not.toContain("gmail.com");
  });

  it("tags the reason so the two limits are distinguishable downstream", () => {
    expect(limitPayload("fr", "hourly_quota", 3600).reason).toBe("hourly_quota");
    expect(limitPayload("fr", "consecutive_messages", 60).reason).toBe("consecutive_messages");
  });
});

describe("documented limits", () => {
  it("matches the requested numbers", () => {
    // 10 -> 20 in v0.5.71.0 at the operator's instruction. This LOOSENS the per-IP ceiling;
    // the security work in that release was the token gate, not this number.
    expect(MAX_MESSAGES_PER_HOUR).toBe(20);
    expect(MAX_CONSECUTIVE_USER_TURNS).toBe(3);
  });
});
