/**
 * PDP "Complétez la pièce" cache + crawler guard — real schema, in-memory libsql, plus the route
 * wiring with the paid assistant mocked.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { Client } from "@libsql/client";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

const runAssistant = vi.fn();
const runComplementary = vi.fn();
vi.mock("@/lib/assistant", () => ({ runAssistant, runComplementary }));

let db: Client;
let cache: typeof import("@/lib/assistant-complementary-cache");
let POST: typeof import("@/app/api/assistant/route").POST;

const RESULT = { reply: "Voici", products: [{ sku: "A1", name: "Table", price: 99, image: "", url: "/products/t", reason: "" }] };
const UA_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const UA_GOOGLEBOT = "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

let ipSeq = 0;
function post(body: unknown, ua: string) {
  return POST(
    new Request("https://app.example/api/assistant", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://ameublodirect.ca", "user-agent": ua, "x-real-ip": `198.51.100.${++ipSeq % 250}` },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  db = await (await import("@/lib/database")).ensureSchema();
  cache = await import("@/lib/assistant-complementary-cache");
  ({ POST } = await import("@/app/api/assistant/route"));
});
beforeEach(async () => {
  await db.execute("DELETE FROM assistant_complementary_cache");
  runComplementary.mockReset().mockResolvedValue(RESULT);
});

describe("cache module", () => {
  it("keys are case/space-insensitive and locale-specific", () => {
    const k = cache.complementaryCacheKey;
    expect(k("Sofa  Gris", "Salon", "fr")).toBe(k(" sofa gris ", "salon", "fr"));
    expect(k("Sofa", "Salon", "fr")).not.toBe(k("Sofa", "Salon", "en"));
  });
  it("round-trips, expires after the TTL, and never caches an empty answer", async () => {
    const now = 1_800_000_000;
    await cache.putCachedComplementary("k1", RESULT, now);
    expect(await cache.getCachedComplementary("k1", now + 60)).toEqual(RESULT);
    expect(await cache.getCachedComplementary("k1", now + cache.COMPLEMENTARY_TTL_SECS + 1)).toBeNull();
    await cache.putCachedComplementary("k2", { reply: "", products: [] }, now);
    expect(await cache.getCachedComplementary("k2", now)).toBeNull();
  });
  it("recognises crawlers but not real browsers", () => {
    expect(cache.isBotUserAgent(UA_GOOGLEBOT)).toBe(true);
    expect(cache.isBotUserAgent("facebookexternalhit/1.1")).toBe(true);
    expect(cache.isBotUserAgent(UA_CHROME)).toBe(false);
  });
});

describe("POST /api/assistant mode=complementary", () => {
  const body = { mode: "complementary", name: "Sofa sectionnel", productType: "Canapés", locale: "fr" };

  it("calls the LLM once per product, then serves the cache", async () => {
    const r1 = await post(body, UA_CHROME);
    const r2 = await post(body, UA_CHROME);
    expect((await r1.json()).data).toEqual(RESULT);
    expect((await r2.json()).data).toEqual(RESULT);
    expect(runComplementary).toHaveBeenCalledTimes(1);
  });

  it("never spends tokens on a crawler", async () => {
    const res = await post(body, UA_GOOGLEBOT);
    expect(await res.json()).toEqual({ success: true, data: { reply: "", products: [] } });
    expect(runComplementary).not.toHaveBeenCalled();
  });
});
