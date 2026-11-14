import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Token savings (2026-10-02): first-question answer cache, lean rows re-sent on every step,
 * spec-first product descriptions.
 */

const runAssistant = vi.fn();
const runComplementary = vi.fn();
vi.mock("@/lib/assistant", () => ({ runAssistant, runComplementary }));

const db = vi.hoisted(() => ({
  countAssistantRequests: vi.fn(),
  recordAssistantRequest: vi.fn(),
  secondsUntilAssistantSlot: vi.fn(),
  getAssistantBlock: vi.fn(),
  getAssistantIpDay: vi.fn(),
  addAssistantIpUsage: vi.fn(),
  blockAssistantIp: vi.fn(),
}));
vi.mock("@/lib/database", () => db);

const cache = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock("@/lib/assistant-answer-cache", async (orig) => {
  const real = await orig<typeof import("@/lib/assistant-answer-cache")>();
  return {
    ...real,
    getCachedAnswer: vi.fn(async (k: string) => cache.store.get(k) ?? null),
    putCachedAnswer: vi.fn(async (k: string, r: never) => {
      if (real.isCacheableAnswer(r)) cache.store.set(k, { reply: (r as { reply: string }).reply, products: [] });
    }),
  };
});

const { POST } = await import("@/app/api/assistant/route");
const { normalizeQuestion, answerCacheKey, isCacheableAnswer } = await import("@/lib/assistant-answer-cache");
const { specFirst } = await import("@/lib/product-details");

function post(body: unknown) {
  return POST(new Request("https://app.example/api/assistant", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://ameublodirect.ca", "x-real-ip": "10.9.9.9" },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  cache.store.clear();
  for (const f of Object.values(db)) f.mockReset();
  db.countAssistantRequests.mockResolvedValue(0);
  db.getAssistantBlock.mockResolvedValue(null);
  db.getAssistantIpDay.mockResolvedValue({ tokens: 0, messages: 0, abuseScore: 0 });
  db.addAssistantIpUsage.mockResolvedValue({ tokens: 0, messages: 0, abuseScore: 0 });
  runAssistant.mockReset().mockResolvedValue({ reply: "Livraison gratuite, 3 à 5 jours.", products: [], meta: { tokens: 6000, flag: null } });
});

describe("first-question answer cache", () => {
  it("normalizes case, spacing and trailing punctuation", () => {
    expect(normalizeQuestion("  Délais   et frais de LIVRAISON ?! ")).toBe("délais et frais de livraison");
    expect(answerCacheKey("Retours ?", "fr")).toBe(answerCacheKey("retours", "fr"));
    expect(answerCacheKey("retours", "fr")).not.toBe(answerCacheKey("retours", "en"));
  });

  it("never replays a flagged, empty or no-match answer", () => {
    expect(isCacheableAnswer({ reply: "ok", products: [], meta: { tokens: 1, flag: "off_topic" } })).toBe(false);
    expect(isCacheableAnswer({ reply: "", products: [] })).toBe(false);
    expect(isCacheableAnswer({ reply: "Je n'ai pas trouvé de produits dans cette gamme.", products: [] })).toBe(false);
    expect(isCacheableAnswer({ reply: "Livraison gratuite.", products: [] })).toBe(true);
  });

  it("serves the second identical opening question from the cache: no model call, no tokens", async () => {
    await post({ message: "Délais et frais de livraison", locale: "fr" });
    const res = await post({ message: "délais et frais de livraison ?", locale: "fr" });
    expect(runAssistant).toHaveBeenCalledTimes(1);
    expect((await res.json()).data.reply).toBe("Livraison gratuite, 3 à 5 jours.");
    // The cached hit still counts as a message for the visitor, at 0 tokens.
    expect(db.addAssistantIpUsage).toHaveBeenLastCalledWith(expect.any(String), { messages: 1 });
  });

  it("never uses the cache once the conversation has history", async () => {
    await post({ message: "Délais et frais de livraison", locale: "fr" });
    await post({ message: "Délais et frais de livraison", locale: "fr", history: [{ role: "user", content: "Bonjour" }, { role: "assistant", content: "Bonjour !" }] });
    expect(runAssistant).toHaveBeenCalledTimes(2);
  });
});

describe("spec-first product descriptions", () => {
  it("keeps dimension / material / assembly lines when trimming", () => {
    const text = ["Un magnifique sofa pour toute la famille.", "Parfait pour les soirées cinéma.", "Largeur : 84 po", "Matériau : velours", "Assemblage requis, outils inclus"].join("\n");
    const out = specFirst(text, 60);
    expect(out.startsWith("Largeur : 84 po\nMatériau : velours")).toBe(true);
    expect(out).not.toContain("soirées cinéma");
  });
});
