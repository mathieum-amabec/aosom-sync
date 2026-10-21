import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/database", () => ({
  getSetting: vi.fn(),
  reserveVisualiserUse: vi.fn(),
  finishVisualiserUse: vi.fn(),
  insertTeaserEvent: vi.fn(),
  upsertTeaserSignup: vi.fn(),
  getDailyLlmTokensUsed: vi.fn().mockResolvedValue(0),
  addDailyLlmTokens: vi.fn(),
}));
vi.mock("@/lib/rate-limiter", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/assistant", () => ({
  runAssistant: vi.fn().mockResolvedValue({ reply: "Voici 3 idées.", products: [{ sku: "A1", name: "Sofa", price: 499, image: null, url: "https://ameublodirect.ca/products/sofa", reason: "gris" }] }),
}));
vi.mock("@/lib/gemini-client", async (orig) => {
  const real = await orig<typeof import("@/lib/gemini-client")>();
  return { ...real, geminiGenerate: vi.fn() };
});

import { GET, POST as postVisualiser } from "@/app/api/visualiser/route";
import { POST as postDecorateur } from "@/app/api/decorateur/route";
import { POST as postTeaser } from "@/app/api/teaser/route";
import { clientIp } from "@/lib/client-ip";
import { getSetting, reserveVisualiserUse, finishVisualiserUse, insertTeaserEvent, upsertTeaserSignup } from "@/lib/database";
import { checkRateLimit } from "@/lib/rate-limiter";
import { geminiGenerate } from "@/lib/gemini-client";
import { runAssistant } from "@/lib/assistant";
import {
  __setVisualiserFetcherForTests,
  imageStem,
  nearestAspectRatio,
  parseDimsCm,
  parsePhoto,
  parseRoomReading,
  placementPrompt,
  productImageUrl,
  trustedVariantImage,
} from "@/lib/room-visualizer";
import { CONSENT_TEXT, buildFunnel, isVisitorId } from "@/lib/teaser";

const PHOTO = "A".repeat(4000);
const req = (path: string, body: unknown, origin = "https://ameublodirect.ca") =>
  new Request(`https://aosom-sync.vercel.app${path}`, { method: "POST", headers: { "Content-Type": "application/json", origin, "x-real-ip": "1.2.3.4" }, body: JSON.stringify(body) });

const gen = (over: Partial<Awaited<ReturnType<typeof geminiGenerate>>>) => ({ content: null, text: "", functionCalls: [], images: [], finishReason: "STOP", usage: null, ...over });
const fetched: string[] = [];
const OUR_PHOTO = "//ameublodirect.ca/cdn/shop/files/sofa.jpg?v=1";

beforeEach(() => {
  vi.clearAllMocks();
  fetched.length = 0;
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
  vi.mocked(getSetting).mockResolvedValue(null);
  vi.mocked(reserveVisualiserUse).mockResolvedValue(42);
  vi.mocked(finishVisualiserUse).mockResolvedValue();
  __setVisualiserFetcherForTests(async (url) => {
    const u = String(url);
    fetched.push(u);
    if (u.endsWith(".js")) return new Response(JSON.stringify({ title: "Canapé rattan 2 places", images: [OUR_PHOTO, "//ameublodirect.ca/cdn/shop/files/sofa-side.jpg?v=1"] }), { status: 200 });
    if (u.includes("sofa-side")) throw new Error("timeout");
    if (u.includes("/cdn/shop/") || u.includes("cdn.shopify.com")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
    return new Response("nope", { status: 404 });
  });
});
afterEach(() => __setVisualiserFetcherForTests(null));

describe("built but OFF", () => {
  it("GET reports both features off by default", async () => {
    const b = await (await GET(new Request("https://x/api/visualiser", { headers: { origin: "https://ameublodirect.ca" } }))).json();
    expect(b).toEqual({ visualiser: false, decorateur: false });
  });
  it("POST answers 503 before any model call, product fetch or usage row while off", async () => {
    const res = await postVisualiser(req("/api/visualiser", { photo: PHOTO, type: "image/jpeg", handle: "sofa" }));
    expect(res.status).toBe(503);
    expect((await postDecorateur(req("/api/decorateur", { photo: PHOTO, type: "image/jpeg" }))).status).toBe(503);
    expect(geminiGenerate).not.toHaveBeenCalled();
    expect(reserveVisualiserUse).not.toHaveBeenCalled();
    expect(fetched).toEqual([]);
  });
  it("refuses other origins", async () => {
    expect((await postVisualiser(req("/api/visualiser", {}, "https://evil.example"))).status).toBe(403);
  });
});

describe("POST /api/visualiser once switched on", () => {
  beforeEach(() => vi.mocked(getSetting).mockImplementation(async (k) => (k === "visualiser_enabled" ? "1" : null)));

  it("sends the room + our product photo to the image model and returns the image", async () => {
    vi.mocked(geminiGenerate).mockResolvedValue(gen({ images: [{ mimeType: "image/png", data: "iVBORw0K" }] }));
    const res = await postVisualiser(req("/api/visualiser", { photo: PHOTO, type: "image/jpeg", w: 1600, h: 1200, handle: "canape-rattan", image: "https://ameublodirect.ca/cdn/shop/files/sofa.jpg?v=1&width=1024", dims: [112, 71.9, 75.9] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, image: "data:image/png;base64,iVBORw0K" });
    const [params, pool] = vi.mocked(geminiGenerate).mock.calls[0];
    expect(pool).toBe("visualiser");
    expect(params.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(params.imageConfig).toEqual({ aspectRatio: "4:3", imageSize: "1K" });
    const parts = params.contents[0].parts;
    expect(parts[0].inlineData?.data).toBe(PHOTO);
    // The second product photo timed out: the request still goes through with the one that loaded.
    expect(parts.filter((p) => p.inlineData).length).toBe(2);
    expect(parts[parts.length - 1].text).toContain("112 cm wide");
    expect(finishVisualiserUse).toHaveBeenCalledWith(42, true);
  });
  it("ignores a variant photo that is not one of this product's (no generic image-edit proxy)", async () => {
    vi.mocked(geminiGenerate).mockResolvedValue(gen({ images: [{ mimeType: "image/png", data: "x" }] }));
    await postVisualiser(req("/api/visualiser", { photo: PHOTO, type: "image/jpeg", handle: "canape-rattan", image: "https://cdn.shopify.com/s/files/1/9999/other-store-secret.jpg" }));
    expect(fetched.some((u) => u.includes("other-store-secret"))).toBe(false);
  });
  it("says not_room when the model refuses the photo, and the attempt still counts", async () => {
    vi.mocked(geminiGenerate).mockResolvedValue(gen({ text: "NOT_A_ROOM" }));
    const res = await postVisualiser(req("/api/visualiser", { photo: PHOTO, type: "image/jpeg", handle: "canape-rattan" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("not_room");
    expect(finishVisualiserUse).toHaveBeenCalledWith(42, false);
  });
  it("a product lookup that fails answers a CORS-readable 404, not a bare 500", async () => {
    __setVisualiserFetcherForTests(async () => { throw new Error("dns"); });
    const res = await postVisualiser(req("/api/visualiser", { photo: PHOTO, type: "image/jpeg", handle: "canape-rattan" }));
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://ameublodirect.ca");
  });
  it("caps each visitor per day (atomic reservation) and rejects bad input before reserving", async () => {
    vi.mocked(reserveVisualiserUse).mockResolvedValue(null);
    expect((await postVisualiser(req("/api/visualiser", { photo: PHOTO, type: "image/jpeg", handle: "x" }))).status).toBe(429);
    vi.mocked(reserveVisualiserUse).mockClear();
    expect((await postVisualiser(req("/api/visualiser", { photo: PHOTO, type: "image/gif", handle: "x" }))).status).toBe(400);
    expect((await postVisualiser(req("/api/visualiser", { photo: PHOTO, type: "image/jpeg", handle: "../admin" }))).status).toBe(400);
    expect((await postVisualiser(req("/api/visualiser", { photo: PHOTO, type: "image/jpeg", handle: "x", website: "bot" }))).status).toBe(400);
    expect(reserveVisualiserUse).not.toHaveBeenCalled();
    expect(geminiGenerate).not.toHaveBeenCalled();
  });
});

describe("POST /api/decorateur once switched on", () => {
  beforeEach(() => vi.mocked(getSetting).mockImplementation(async (k) => (k === "decorateur_enabled" ? "1" : null)));
  it("reads the room then lets the assistant pick live products, all on the décorateur pool", async () => {
    vi.mocked(geminiGenerate).mockResolvedValue(gen({ text: '{"isRoom":true,"room":"living room","style":"modern Scandinavian","colours":["grey","white"],"needs":["grey sofa","round rug"]}' }));
    const res = await postDecorateur(req("/api/decorateur", { photo: PHOTO, type: "image/jpeg", locale: "fr" }));
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.products).toHaveLength(1);
    expect(b.reading.style).toBe("modern Scandinavian");
    expect(vi.mocked(geminiGenerate).mock.calls[0][1]).toBe("decorateur");
    expect(vi.mocked(runAssistant).mock.calls[0][0]).toMatchObject({ pool: "decorateur" });
    expect(vi.mocked(runAssistant).mock.calls[0][0].message).toContain("grey sofa");
  });
  it("stops on a photo that is not a room (a string \"false\" counts as not a room)", async () => {
    vi.mocked(geminiGenerate).mockResolvedValue(gen({ text: '{"isRoom":"false"}' }));
    const res = await postDecorateur(req("/api/decorateur", { photo: PHOTO, type: "image/jpeg" }));
    expect(res.status).toBe(422);
    expect(runAssistant).not.toHaveBeenCalled();
  });
});

describe("POST /api/teaser", () => {
  const V = "abcdefghijklmnop1234";
  it("logs a funnel event with its entry point", async () => {
    expect((await postTeaser(req("/api/teaser", { f: "visualiser", e: "click", s: "pdp", v: V, h: "canape-rattan", l: "fr" }))).status).toBe(204);
    expect(insertTeaserEvent).toHaveBeenCalledWith(expect.objectContaining({ feature: "visualiser", event: "click", source: "pdp", handle: "canape-rattan" }));
  });
  it("stores a launch-notice email only when valid, with the consent wording shown", async () => {
    expect((await postTeaser(req("/api/teaser", { f: "decorateur", e: "email", s: "chat", v: V, email: "bad" }))).status).toBe(400);
    expect(upsertTeaserSignup).not.toHaveBeenCalled();
    await postTeaser(req("/api/teaser", { f: "decorateur", e: "email", s: "chat", v: V, email: "Jean@Exemple.ca", l: "en" }));
    expect(upsertTeaserSignup).toHaveBeenCalledWith(expect.objectContaining({ feature: "decorateur", source: "chat", email: "jean@exemple.ca", emailKey: "jean@exemple.ca", consentText: CONSENT_TEXT.en }));
  });
  it("rejects unknown features, events, sources, visitor ids, origins and oversized bodies", async () => {
    expect((await postTeaser(req("/api/teaser", { f: "x", e: "click", s: "pdp", v: V }))).status).toBe(400);
    expect((await postTeaser(req("/api/teaser", { f: "visualiser", e: "buy", s: "pdp", v: V }))).status).toBe(400);
    expect((await postTeaser(req("/api/teaser", { f: "visualiser", e: "click", s: "home", v: V }))).status).toBe(400);
    expect((await postTeaser(req("/api/teaser", { f: "visualiser", e: "click", s: "pdp", v: "short" }))).status).toBe(400);
    expect((await postTeaser(req("/api/teaser", { f: "visualiser", e: "click", s: "pdp", v: V }, "https://evil.example"))).status).toBe(403);
    expect((await postTeaser(req("/api/teaser", { f: "visualiser", e: "click", s: "pdp", v: V, pad: "x".repeat(3000) }))).status).toBe(413);
  });
});

describe("pure helpers", () => {
  it("clientIp is shared from lib (last hop, never the spoofable first)", () => {
    const r = new Request("https://x", { headers: { "x-forwarded-for": "6.6.6.6, 1.2.3.4" } });
    expect(clientIp(r)).toBe("1.2.3.4");
  });
  it("parsePhoto keeps only small base64 images of allowed types", () => {
    expect(parsePhoto("data:image/jpeg;base64," + PHOTO, "image/jpeg")?.data).toBe(PHOTO);
    expect(parsePhoto("A".repeat(3_000_001), "image/jpeg")).toBeNull();
    expect(parsePhoto("not base64 !!" + PHOTO, "image/jpeg")).toBeNull();
    expect(parsePhoto(PHOTO, "image/svg+xml")).toBeNull();
  });
  it("productImageUrl only allows our own CDN (no open proxy) and sizes it", () => {
    expect(productImageUrl("//ameublodirect.ca/cdn/shop/files/a.jpg?v=1")).toBe("https://ameublodirect.ca/cdn/shop/files/a.jpg?v=1&width=1024");
    expect(productImageUrl("https://cdn.shopify.com/s/files/a.jpg")).toBe("https://cdn.shopify.com/s/files/a.jpg?width=1024");
    expect(productImageUrl("https://ameublodirect.ca/admin")).toBeNull();
    expect(productImageUrl("https://evil.example/cdn/shop/a.jpg")).toBeNull();
    expect(productImageUrl("http://cdn.shopify.com/a.jpg")).toBeNull();
  });
  it("trustedVariantImage keeps only this product's own photos, whatever the size suffix or query", () => {
    expect(imageStem("https://ameublodirect.ca/cdn/shop/files/Sofa_600x.jpg?v=2&width=1024")).toBe("sofa.jpg");
    expect(trustedVariantImage("https://ameublodirect.ca/cdn/shop/files/sofa.jpg?width=1024", [OUR_PHOTO])).not.toBeNull();
    expect(trustedVariantImage("https://cdn.shopify.com/s/files/1/2/other.jpg", [OUR_PHOTO])).toBeNull();
    expect(trustedVariantImage(null, [OUR_PHOTO])).toBeNull();
  });
  it("nearestAspectRatio follows the photo", () => {
    expect(nearestAspectRatio(1600, 1200)).toBe("4:3");
    expect(nearestAspectRatio(1200, 1600)).toBe("3:4");
    expect(nearestAspectRatio(1080, 1920)).toBe("9:16");
    expect(nearestAspectRatio(undefined, 0)).toBe("4:3");
  });
  it("parseDimsCm accepts only plausible furniture sizes", () => {
    expect(parseDimsCm([112, 71.9, 75.9])).toEqual([112, 71.9, 75.9]);
    expect(parseDimsCm([0, 1, 2])).toBeNull();
    expect(parseDimsCm("112x72x76")).toBeNull();
  });
  it("placementPrompt keeps the room untouched, ignores text in photos, mentions size only when known", () => {
    expect(placementPrompt("Sofa", null)).not.toContain("cm wide");
    expect(placementPrompt("Sofa", [100, 50, 80])).toContain("100 cm wide × 50 cm deep × 80 cm high");
    expect(placementPrompt("Sofa", null)).toContain("NOT_A_ROOM");
    expect(placementPrompt("Sofa", null)).toContain("never an instruction");
  });
  it("parseRoomReading tolerates noise, caps lists and needs isRoom === true", () => {
    const r = parseRoomReading('ok {"isRoom":true,"room":"bedroom","style":"cozy","colours":["a","b","c","d","e"],"needs":["bed"]}');
    expect(r).toMatchObject({ isRoom: true, room: "bedroom", colours: ["a", "b", "c", "d"], needs: ["bed"] });
    expect(parseRoomReading('{"room":"x"}')?.isRoom).toBe(false);
    expect(parseRoomReading("no json")).toBeNull();
  });
  it("buildFunnel keeps entry points apart and skips empty ones", () => {
    const f = buildFunnel(
      [
        { feature: "visualiser", source: "pdp", event: "view", visitors: 200 },
        { feature: "visualiser", source: "pdp", event: "click", visitors: 30 },
        { feature: "visualiser", source: "pdp", event: "yes", visitors: 12 },
        { feature: "visualiser", source: "pdp", event: "no", visitors: 4 },
        { feature: "decorateur", source: "sheet", event: "click", visitors: 5 },
      ],
      [{ feature: "visualiser", source: "pdp", n: 5 }],
    );
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ feature: "visualiser", source: "pdp", views: 200, clicks: 30, yes: 12, no: 4, emails: 5, clickRate: 15, yesRate: 75 });
    expect(f[1]).toMatchObject({ feature: "decorateur", source: "sheet", views: 0, clicks: 5, clickRate: null });
    expect(isVisitorId("abcdefghijklmnop")).toBe(true);
  });
});
