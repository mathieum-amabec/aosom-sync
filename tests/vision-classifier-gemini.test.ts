/**
 * classifyProductImageGemini — the cheaper, gallery-wide sibling of classifyProductImage.
 * Same validated STRICT_OVERLAY_PROMPT and ImageClassification contract, routed through
 * Vercel AI Gateway to Gemini instead of straight to Anthropic. Separate test file: this
 * function needs AI_GATEWAY_API_KEY, not the Anthropic SDK, so it gets its own config mock
 * rather than sharing vision-classifier.test.ts's Claude-focused one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let aiGatewayApiKey: string | undefined = "test-gateway-key";
vi.mock("@/lib/config", () => ({
  env: {
    get aiGatewayApiKey() { return aiGatewayApiKey; },
  },
  CLAUDE: { MODEL: "claude-sonnet-4-6", MODEL_BATCH: "claude-haiku-4-5", MAX_TOKENS_CONTENT: 1000, MAX_TOKENS_SOCIAL: 500 },
}));

const { classifyProductImageGemini, GEMINI_CLASSIFY_PX } = await import("@/lib/vision-classifier");

function gatewayReply(obj: unknown) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }] }) };
}

beforeEach(() => {
  aiGatewayApiKey = "test-gateway-key";
  vi.stubGlobal("fetch", vi.fn());
});

describe("classifyProductImageGemini", () => {
  it("returns compliant=true for a clean image", async () => {
    vi.mocked(fetch).mockResolvedValue(gatewayReply({ has_marketing_overlay: false, confidence: 0.9, reason: "image propre" }) as never);
    const res = await classifyProductImageGemini("https://cdn.example.com/pic.jpg");
    expect(res).toEqual({ compliant: true, reason: "image propre", confidence: 0.9 });
  });

  it("returns compliant=false when marketing/measurement overlay is detected", async () => {
    vi.mocked(fetch).mockResolvedValue(gatewayReply({ has_marketing_overlay: true, confidence: 0.85, reason: "dimensions superposées" }) as never);
    const res = await classifyProductImageGemini("https://cdn.example.com/dims.jpg");
    expect(res.compliant).toBe(false);
    expect(res.reason).toBe("dimensions superposées");
  });

  it("calls the AI Gateway chat completions endpoint with the gemini-2.5-flash-lite model and the shared prompt", async () => {
    vi.mocked(fetch).mockResolvedValue(gatewayReply({ has_marketing_overlay: false, confidence: 1, reason: "ok" }) as never);
    await classifyProductImageGemini("https://cdn.example.com/pic.jpg");

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-gateway-key" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("google/gemini-2.5-flash-lite");
    expect(body.messages[0]).toEqual({ role: "system", content: expect.stringContaining("TEXTE MARKETING INCRUSTÉ") });
  });

  it("requests the 384x384 resized variant of a Shopify CDN url — the flat-rate Gemini tile", async () => {
    vi.mocked(fetch).mockResolvedValue(gatewayReply({ has_marketing_overlay: false, confidence: 1, reason: "ok" }) as never);
    expect(GEMINI_CLASSIFY_PX).toBe(384);
    await classifyProductImageGemini("https://cdn.shopify.com/s/files/1/pic.jpg?v=1");

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    const imgBlock = body.messages[1].content.find((b: { type: string }) => b.type === "image_url");
    expect(imgBlock.image_url.url).toBe("https://cdn.shopify.com/s/files/1/pic_384x384.jpg?v=1");
  });

  it("throws when AI_GATEWAY_API_KEY is not set — never silently skips or falls back", async () => {
    aiGatewayApiKey = undefined;
    await expect(classifyProductImageGemini("https://cdn.example.com/pic.jpg")).rejects.toThrow(/AI_GATEWAY_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on an empty url", async () => {
    await expect(classifyProductImageGemini("")).rejects.toThrow(/empty imageUrl/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws when the Gateway responds with a non-OK status", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" } as never);
    await expect(classifyProductImageGemini("https://cdn.example.com/pic.jpg")).rejects.toThrow(/Gateway 429/);
  });

  it("throws when the reply has no JSON (never a false compliant)", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "désolé" } }] }) } as never);
    await expect(classifyProductImageGemini("https://cdn.example.com/pic.jpg")).rejects.toThrow(/no JSON/);
  });

  it("throws when has_marketing_overlay is missing/non-boolean", async () => {
    vi.mocked(fetch).mockResolvedValue(gatewayReply({ confidence: 0.5, reason: "ambigu" }) as never);
    await expect(classifyProductImageGemini("https://cdn.example.com/pic.jpg")).rejects.toThrow(/has_marketing_overlay/);
  });

  it("falls back to a default reason when the model omits one", async () => {
    vi.mocked(fetch).mockResolvedValue(gatewayReply({ has_marketing_overlay: true, confidence: 0.6 }) as never);
    const res = await classifyProductImageGemini("https://cdn.example.com/pic.jpg");
    expect(res.reason).toMatch(/texte marketing/);
  });

  it("clamps an out-of-range confidence into 0..1", async () => {
    vi.mocked(fetch).mockResolvedValue(gatewayReply({ has_marketing_overlay: false, confidence: 1.4, reason: "ok" }) as never);
    const res = await classifyProductImageGemini("https://cdn.example.com/pic.jpg");
    expect(res.confidence).toBe(1);
  });
});
