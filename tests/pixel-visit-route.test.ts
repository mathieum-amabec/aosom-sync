import { describe, it, expect, vi, beforeEach } from "vitest";

const insertVisitorSession = vi.fn(async () => {});
const markVisitorSession = vi.fn(async () => {});
const getSetting = vi.fn(async (): Promise<string | null> => null);
vi.mock("@/lib/database", () => ({ insertVisitorSession, markVisitorSession, getSetting }));

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)";
const VID = "0123456789abcdef0123456789abcdef";

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://outils.ameublodirect.ca/api/pixel/visit", {
    method: "POST",
    headers: { origin: "https://ameublodirect.ca", "user-agent": UA, "x-vercel-ip-country": "ca", "x-real-ip": `10.0.0.${Math.floor(Math.random() * 250)}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/pixel/visit", () => {
  beforeEach(() => { insertVisitorSession.mockClear(); markVisitorSession.mockClear(); getSetting.mockResolvedValue(null); });

  it("stores a visit with the landing path, utm, host of the referrer, country and device — never the query or IP", async () => {
    const { POST } = await import("@/app/api/pixel/visit/route");
    const r = await POST(req({ t: "visit", v: VID, n: 2, f: 1763300000000, g: 3.456, u: "https://ameublodirect.ca/products/sofa?utm_source=facebook&fbclid=x&email=a@b.ca", r: "https://www.google.com/search?q=sofa" }));
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://ameublodirect.ca");
    expect(insertVisitorSession).toHaveBeenCalledWith(expect.objectContaining({
      visitN: 2, pre: false, firstSeen: 1763300000, gapDays: 3.46, host: "ameublodirect.ca", landing: "/products/sofa",
      referrer: "google.com", utmSource: "facebook", fbclid: true, country: "CA", device: "mobile",
    }));
    const arg = (insertVisitorSession.mock.calls[0] as unknown[])[0] as { visitorHash: string };
    expect(arg.visitorHash).toMatch(/^[0-9a-f]{32}$/);
    expect(arg.visitorHash).not.toBe(VID);
  });

  it("flags ATC / checkout on the visit", async () => {
    const { POST } = await import("@/app/api/pixel/visit/route");
    expect((await POST(req({ t: "atc", v: VID, n: 1 }))).status).toBe(204);
    expect(markVisitorSession).toHaveBeenCalledWith(expect.any(String), 1, "atc", { country: "CA", device: "mobile" });
  });

  it("rejects other origins and bad payloads, ignores bots, and stores nothing when switched off", async () => {
    const { POST } = await import("@/app/api/pixel/visit/route");
    expect((await POST(req({ t: "visit", v: VID, n: 1 }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(req({ t: "purchase", v: VID, n: 1 }))).status).toBe(400);
    expect((await POST(req({ t: "visit", v: "short", n: 1 }))).status).toBe(400);
    expect((await POST(req({ t: "visit", v: VID, n: 0 }))).status).toBe(400);
    expect((await POST(req("not json"))).status).toBe(400);
    expect((await POST(req({ t: "visit", v: VID, n: 1 }, { "user-agent": "Googlebot/2.1" }))).status).toBe(204);
    getSetting.mockResolvedValue("0");
    expect((await POST(req({ t: "visit", v: VID, n: 1 }))).status).toBe(204);
    expect(insertVisitorSession).not.toHaveBeenCalled();
    expect(markVisitorSession).not.toHaveBeenCalled();
  });
});
