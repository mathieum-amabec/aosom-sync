import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the (paid) assistant lib so route tests never call Claude.
const runAssistant = vi.fn();
const runComplementary = vi.fn();
vi.mock("@/lib/assistant", () => ({ runAssistant, runComplementary }));

const { POST, OPTIONS } = await import("@/app/api/assistant/route");

const ALLOWED = "https://ameublodirect.ca";
function post(body: unknown, opts: { origin?: string | null; ip?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin !== null) headers["origin"] = opts.origin ?? ALLOWED;
  if (opts.ip) headers["x-real-ip"] = opts.ip;
  return POST(new Request("https://app.example/api/assistant", { method: "POST", headers, body: JSON.stringify(body) }));
}

beforeEach(() => {
  runAssistant.mockReset().mockResolvedValue({ reply: "ok", products: [] });
  runComplementary.mockReset().mockResolvedValue({ reply: "ok", products: [] });
});

describe("POST /api/assistant — security gates", () => {
  it("rejects a request with no Origin (blocks direct curl)", async () => {
    const res = await post({ message: "sofa" }, { origin: null, ip: "10.0.0.1" });
    expect(res.status).toBe(403);
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it("rejects a disallowed Origin (another store cannot use our endpoint)", async () => {
    const res = await post({ message: "sofa" }, { origin: "https://evil.myshopify.com", ip: "10.0.0.2" });
    expect(res.status).toBe(403);
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it("accepts an allowed storefront Origin and echoes the CORS header", async () => {
    const res = await post({ message: "un canapé" }, { origin: ALLOWED, ip: "10.0.0.3" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
    expect(runAssistant).toHaveBeenCalledTimes(1);
  });

  it("400s on a missing/empty message", async () => {
    const res = await post({ message: "   " }, { ip: "10.0.0.4" });
    expect(res.status).toBe(400);
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it("400s on an over-long message", async () => {
    const res = await post({ message: "x".repeat(1001) }, { ip: "10.0.0.5" });
    expect(res.status).toBe(400);
  });

  it("enforces the per-IP rate limit (12/min) keyed on x-real-ip", async () => {
    const ip = "203.0.113.77";
    let last = 200;
    for (let i = 0; i < 13; i++) last = (await post({ message: "sofa" }, { ip })).status;
    expect(last).toBe(429); // the 13th within the window is throttled
  });

  it("routes complementary mode to runComplementary", async () => {
    const res = await post({ mode: "complementary", name: "Canapé", productType: "Sofas" }, { ip: "10.0.0.6" });
    expect(res.status).toBe(200);
    expect(runComplementary).toHaveBeenCalledTimes(1);
    expect(runAssistant).not.toHaveBeenCalled();
  });

  it("OPTIONS preflight returns 204 with the allowed-origin CORS header", async () => {
    const res = OPTIONS(new Request("https://app.example/api/assistant", { method: "OPTIONS", headers: { origin: ALLOWED } }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
  });
});
