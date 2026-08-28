import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_MESSAGES_PER_HOUR } from "@/lib/assistant-limits";

// Mock the (paid) assistant lib so route tests never call Claude.
const runAssistant = vi.fn();
const runComplementary = vi.fn();
vi.mock("@/lib/assistant", () => ({ runAssistant, runComplementary }));

// The route reads/writes the per-IP hourly quota. Mock the DB so these tests stay hermetic
// (no sqlite file, no Turso) and so the quota can be driven deterministically.
const countAssistantRequests = vi.fn();
const recordAssistantRequest = vi.fn();
const secondsUntilAssistantSlot = vi.fn().mockResolvedValue(3600);
vi.mock("@/lib/database", () => ({
  countAssistantRequests,
  recordAssistantRequest,
  secondsUntilAssistantSlot,
}));

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
  countAssistantRequests.mockReset().mockResolvedValue(0);
  recordAssistantRequest.mockReset().mockResolvedValue(undefined);
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

describe("POST /api/assistant — conversation limits", () => {
  // Each test uses its own IP: the in-memory burst limiter is module-level state shared
  // across tests in this file, and a reused IP would trip it instead of the rule under test.
  it("answers normally while the shopper is under the hourly quota", async () => {
    countAssistantRequests.mockResolvedValue(9);
    const res = await post({ message: "un canapé" }, { ip: "10.1.0.1" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.limitReached).toBeUndefined();
    expect(runAssistant).toHaveBeenCalledTimes(1);
    expect(recordAssistantRequest).toHaveBeenCalledWith("10.1.0.1");
  });

  it("hands off to a human at the hourly quota, without spending a Claude call", async () => {
    countAssistantRequests.mockResolvedValue(MAX_MESSAGES_PER_HOUR);
    secondsUntilAssistantSlot.mockResolvedValue(9 * 60);
    const res = await post({ message: "un canapé" }, { ip: "10.1.0.2" });
    const body = await res.json();
    // 429 for machines; `success: true` + data.reply for the shopper, because the deployed
    // widget ignores the status and only renders when j.success is true.
    expect(res.status).toBe(429);
    expect(body.success).toBe(true);
    expect(body.data.limitReached).toBe(true);
    expect(body.data.reason).toBe("hourly_quota");
    expect(body.data.reply).toContain("9 minutes");
    expect(runAssistant).not.toHaveBeenCalled();
    expect(recordAssistantRequest).not.toHaveBeenCalled();
  });

  it("returns the English copy for locale=en", async () => {
    countAssistantRequests.mockResolvedValue(MAX_MESSAGES_PER_HOUR);
    secondsUntilAssistantSlot.mockResolvedValue(9 * 60);
    const res = await post({ message: "a sofa", locale: "en" }, { ip: "10.1.0.3" });
    const body = await res.json();
    expect(body.data.reply).toContain("Please try again in about 9 minutes");
  });

  it("hands off on the 4th consecutive shopper turn, before touching the quota", async () => {
    const history = [
      { role: "assistant", content: "bonjour" },
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "user", content: "c" },
    ];
    const res = await post({ message: "d", history }, { ip: "10.1.0.4" });
    const body = await res.json();
    expect(body.data.limitReached).toBe(true);
    expect(body.data.reason).toBe("consecutive_messages");
    expect(runAssistant).not.toHaveBeenCalled();
    expect(countAssistantRequests).not.toHaveBeenCalled();
  });

  it("does not consume the shopper's allowance when generation fails", async () => {
    runAssistant.mockRejectedValueOnce(new Error("Claude 529"));
    const res = await post({ message: "un canapé" }, { ip: "10.1.0.5" });
    expect(res.status).toBe(500);
    expect(recordAssistantRequest).not.toHaveBeenCalled();
  });

  it("fails OPEN when the quota store is unreachable — the storefront must not go dark", async () => {
    countAssistantRequests.mockRejectedValueOnce(new Error("Turso down"));
    const res = await post({ message: "un canapé" }, { ip: "10.1.0.6" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.limitReached).toBeUndefined();
    expect(runAssistant).toHaveBeenCalledTimes(1);
    // No write either: with the counter unreadable there is nothing coherent to record.
    expect(recordAssistantRequest).not.toHaveBeenCalled();
  });

  it("still answers when only the quota WRITE fails", async () => {
    recordAssistantRequest.mockRejectedValueOnce(new Error("Turso down"));
    const res = await post({ message: "un canapé" }, { ip: "10.1.0.7" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.reply).toBe("ok");
  });

  it("leaves the PDP complementary mode outside the conversation limits", async () => {
    countAssistantRequests.mockResolvedValue(999);
    const res = await post({ mode: "complementary", name: "Chaise", productType: "Chaise" }, { ip: "10.1.0.8" });
    expect(res.status).toBe(200);
    expect(runComplementary).toHaveBeenCalledTimes(1);
  });
});
