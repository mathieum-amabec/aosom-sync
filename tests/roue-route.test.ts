import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/database", () => ({
  getSetting: vi.fn(),
  getWheelSpin: vi.fn(),
  countWheelSpinsForIp: vi.fn(),
  reserveWheelSpin: vi.fn(),
  setWheelSpinCode: vi.fn(),
  releaseWheelSpin: vi.fn(),
}));
vi.mock("@/lib/rate-limiter", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/welcome-wheel", async (orig) => {
  const real = await orig<typeof import("@/lib/welcome-wheel")>();
  return {
    ...real,
    drawPrizeIndex: vi.fn(() => 2),
    createWheelDiscount: vi.fn(),
    subscribeWheelProfile: vi.fn().mockResolvedValue({ ok: true }),
    trackWheelWin: vi.fn().mockResolvedValue({ ok: true }),
  };
});

import { POST, OPTIONS, GET, clientIp } from "@/app/api/roue/route";
import { getSetting, getWheelSpin, countWheelSpinsForIp, reserveWheelSpin, setWheelSpinCode, releaseWheelSpin } from "@/lib/database";
import { checkRateLimit } from "@/lib/rate-limiter";
import { createWheelDiscount, subscribeWheelProfile, trackWheelWin } from "@/lib/welcome-wheel";

function post(body: unknown, origin = "https://ameublodirect.ca") {
  return new Request("https://aosom-sync.vercel.app/api/roue", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin, "x-forwarded-for": "1.2.3.4" },
    body: JSON.stringify(body),
  });
}

const OK = { email: "Jean@Exemple.ca", consent: true, locale: "fr", skill: { a: 4, b: 3, c: 2, answer: "10" } };

describe("POST /api/roue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(getWheelSpin).mockResolvedValue(null);
    vi.mocked(countWheelSpinsForIp).mockResolvedValue(0);
    vi.mocked(reserveWheelSpin).mockResolvedValue(true);
    vi.mocked(createWheelDiscount).mockResolvedValue({ code: "ROUE-ABCDEF", discountId: "gid://shopify/DiscountCodeNode/1", endsAt: "2026-10-23T12:00:00.000Z" });
  });

  it("draws on the server, creates the code, subscribes and fires the flow event", async () => {
    const res = await POST(post(OK));
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b).toMatchObject({ success: true, already: false, code: "ROUE-ABCDEF", prize: { index: 2, amount: 40, minSubtotal: 400 } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://ameublodirect.ca");
    expect(reserveWheelSpin).toHaveBeenCalledWith(expect.objectContaining({ emailKey: "jean@exemple.ca", prizeKey: "40-400" }));
    expect(setWheelSpinCode).toHaveBeenCalledWith("jean@exemple.ca", "ROUE-ABCDEF", "gid://shopify/DiscountCodeNode/1", expect.any(Number));
    expect(subscribeWheelProfile).toHaveBeenCalledWith("jean@exemple.ca", null);
    expect(vi.mocked(trackWheelWin).mock.calls[0][1]).toMatchObject({ code: "ROUE-ABCDEF", prize_fr: "40 $ dès 400 $" });
  });

  it("a repeat spin returns the prize but never the code (anyone can type an email), creating nothing", async () => {
    vi.mocked(getWheelSpin).mockResolvedValue({ id: 1, email_key: "jean@exemple.ca", email: "jean@exemple.ca", prize_key: "15-150", code: "ROUE-OLDONE", discount_id: "x", expires_at: 1_800_000_000, locale: "fr", created_at: 1 });
    const b = await (await POST(post(OK))).json();
    expect(b).toMatchObject({ success: true, already: true, code: null, prize: { index: 0 } });
    expect(createWheelDiscount).not.toHaveBeenCalled();
    expect(trackWheelWin).not.toHaveBeenCalled();
  });

  it("plays without the consent box (CASL: no bundled consent) but sends nothing to Klaviyo", async () => {
    const res = await POST(post({ ...OK, consent: false }));
    expect(res.status).toBe(200);
    expect((await res.json()).code).toBe("ROUE-ABCDEF");
    expect(subscribeWheelProfile).not.toHaveBeenCalled();
    expect(trackWheelWin).not.toHaveBeenCalled();
  });

  it("closes after the end date printed in the rules", async () => {
    vi.useFakeTimers({ now: new Date("2027-02-01T12:00:00Z"), toFake: ["Date"] });
    try {
      expect((await POST(post(OK))).status).toBe(503);
      expect(await (await GET(new Request("https://x/api/roue"))).json()).toEqual({ enabled: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires the right answer to the skill-testing question", async () => {
    for (const skill of [undefined, { a: 4, b: 3, c: 2, answer: "14" }, { a: 4, b: 3, c: 2, answer: "" }, { a: 40, b: 3, c: 2, answer: "46" }]) {
      const res = await POST(post({ ...OK, skill }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("skill");
    }
    expect(createWheelDiscount).not.toHaveBeenCalled();
    expect((await POST(post({ ...OK, skill: { a: 4, b: 3, c: 2, answer: 10 } }))).status).toBe(200);
  });

  it("refuses foreign origins", async () => {
    const res = await POST(post(OK, "https://evil.example"));
    expect(res.status).toBe(403);
    expect(createWheelDiscount).not.toHaveBeenCalled();
  });

  it("silently refuses the honeypot", async () => {
    const res = await POST(post({ ...OK, website: "http://spam" }));
    expect(res.status).toBe(400);
    expect(reserveWheelSpin).not.toHaveBeenCalled();
  });

  it("caps spins per IP per day", async () => {
    vi.mocked(countWheelSpinsForIp).mockResolvedValue(4);
    expect((await POST(post(OK))).status).toBe(429);
    expect(createWheelDiscount).not.toHaveBeenCalled();
  });

  it("kill switch answers 503", async () => {
    vi.mocked(getSetting).mockImplementation(async (k) => (k === "roue_enabled" ? "0" : null));
    expect((await POST(post(OK))).status).toBe(503);
  });

  it("frees the reservation when Shopify fails, so the visitor can retry", async () => {
    vi.mocked(createWheelDiscount).mockRejectedValue(new Error("boom"));
    expect((await POST(post(OK))).status).toBe(502);
    expect(releaseWheelSpin).toHaveBeenCalledWith("jean@exemple.ca");
    expect(trackWheelWin).not.toHaveBeenCalled();
  });

  it("still returns the code when Klaviyo fails", async () => {
    vi.mocked(subscribeWheelProfile).mockRejectedValue(new Error("down"));
    const res = await POST(post(OK));
    expect(res.status).toBe(200);
    expect((await res.json()).code).toBe("ROUE-ABCDEF");
  });

  it("answers a fresh concurrent reservation with 409, and frees a stale one", async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.mocked(getWheelSpin).mockResolvedValueOnce({ id: 1, email_key: "jean@exemple.ca", email: "x", prize_key: "15-150", code: null, discount_id: null, expires_at: null, locale: "fr", created_at: now });
    expect((await POST(post(OK))).status).toBe(409);
    vi.mocked(getWheelSpin).mockResolvedValueOnce({ id: 1, email_key: "jean@exemple.ca", email: "x", prize_key: "15-150", code: null, discount_id: null, expires_at: null, locale: "fr", created_at: now - 900 });
    expect((await POST(post(OK))).status).toBe(200);
    expect(releaseWheelSpin).toHaveBeenCalled();
  });

  it("answers CORS preflight", async () => {
    const res = await OPTIONS(new Request("https://x/api/roue", { method: "OPTIONS", headers: { origin: "https://ameublodirect.ca" } }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://ameublodirect.ca");
  });

  it("limits by the real client IP, not the spoofable first x-forwarded-for hop", () => {
    const req = (h: Record<string, string>) => new Request("https://x/api/roue", { headers: h });
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(req({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "6.6.6.6" }))).toBe("9.9.9.9");
    expect(clientIp(req({ "x-real-ip": "2001:db8:aa:bb:1:2:3:4" }))).toBe("2001:db8:aa:bb::/64");
  });

  it("GET reports the kill switch", async () => {
    vi.mocked(getSetting).mockResolvedValue("0");
    expect(await (await GET(new Request("https://x/api/roue", { headers: { origin: "https://ameublodirect.ca" } }))).json()).toEqual({ enabled: false });
    vi.mocked(getSetting).mockResolvedValue(null);
    expect(await (await GET(new Request("https://x/api/roue"))).json()).toEqual({ enabled: true });
  });
});
