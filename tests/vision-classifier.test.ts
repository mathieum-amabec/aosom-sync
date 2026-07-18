import { describe, it, expect, vi, beforeEach } from "vitest";

// vision-classifier → content-generator → config at module load. Mock config so no real
// env vars are needed; the functions under test only read CLAUDE.MODEL + anthropicApiKey.
vi.mock("@/lib/config", () => ({
  env: { anthropicApiKey: "test-key" },
  CLAUDE: { MODEL: "claude-sonnet-4-6", MAX_TOKENS_CONTENT: 1000, MAX_TOKENS_SOCIAL: 500 },
}));

// Mock the Anthropic SDK — `create` is hoisted so each test sets the canned reply.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const { classifyProductImage } = await import("@/lib/vision-classifier");

function claudeJson(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

beforeEach(() => {
  create.mockReset();
  // Every test image "downloads" successfully unless a test overrides fetch.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode("fake-image-bytes").buffer,
  }));
});

describe("classifyProductImage", () => {
  it("returns compliant=true for a clean image (no marketing overlay)", async () => {
    create.mockResolvedValue(claudeJson({ has_marketing_overlay: false, confidence: 0.95, reason: "image propre" }));
    const res = await classifyProductImage("https://cdn.example.com/pic.jpg");
    expect(res.compliant).toBe(true);
    expect(res.reason).toBe("image propre");
  });

  it("returns compliant=false when marketing text overlay is detected", async () => {
    create.mockResolvedValue(claudeJson({ has_marketing_overlay: true, confidence: 0.9, reason: "badge -50% incrusté" }));
    const res = await classifyProductImage("https://cdn.example.com/promo.jpg");
    expect(res.compliant).toBe(false);
    expect(res.reason).toBe("badge -50% incrusté");
  });

  it("treats diegetic text as compliant (model returns has_marketing_overlay=false)", async () => {
    create.mockResolvedValue(claudeJson({ has_marketing_overlay: false, confidence: 0.7, reason: "titre de livre sur l'étagère" }));
    const res = await classifyProductImage("https://cdn.example.com/shelf.jpg");
    expect(res.compliant).toBe(true);
  });

  it("requests the 1024x1024 resized variant of a Shopify CDN url", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    create.mockResolvedValue(claudeJson({ has_marketing_overlay: false, confidence: 1, reason: "ok" }));
    await classifyProductImage("https://cdn.shopify.com/s/files/1/pic.png?v=123");
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.shopify.com/s/files/1/pic_1024x1024.png?v=123");
  });

  it("does NOT rewrite a non-Shopify CDN url (the _1024x1024 transform is Shopify-only)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    create.mockResolvedValue(claudeJson({ has_marketing_overlay: false, confidence: 1, reason: "ok" }));
    await classifyProductImage("https://feed-us.aosomcdn.com/pic.jpg");
    expect(fetchMock).toHaveBeenCalledWith("https://feed-us.aosomcdn.com/pic.jpg");
  });

  it("sends the image with the correct media_type derived from the extension", async () => {
    create.mockResolvedValue(claudeJson({ has_marketing_overlay: false, confidence: 1, reason: "ok" }));
    await classifyProductImage("https://cdn.example.com/pic.webp");
    const arg = create.mock.calls[0][0];
    expect(arg.model).toBe("claude-sonnet-4-6");
    const imgBlock = arg.messages[0].content.find((b: { type: string }) => b.type === "image");
    expect(imgBlock.source.media_type).toBe("image/webp");
  });

  it("throws on an empty url (never silently 'compliant')", async () => {
    await expect(classifyProductImage("")).rejects.toThrow(/empty imageUrl/);
    expect(create).not.toHaveBeenCalled();
  });

  it("throws when the image download fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }));
    await expect(classifyProductImage("https://cdn.example.com/missing.jpg")).rejects.toThrow(/image download 404/);
  });

  it("throws when Claude returns no JSON (never a false compliant)", async () => {
    create.mockResolvedValue({ content: [{ type: "text", text: "désolé, je ne peux pas" }] });
    await expect(classifyProductImage("https://cdn.example.com/pic.jpg")).rejects.toThrow(/no JSON/);
  });

  it("throws when has_marketing_overlay is missing/non-boolean", async () => {
    create.mockResolvedValue(claudeJson({ confidence: 0.5, reason: "ambigu" }));
    await expect(classifyProductImage("https://cdn.example.com/pic.jpg")).rejects.toThrow(/has_marketing_overlay/);
  });

  it("falls back to a default reason when the model omits one", async () => {
    create.mockResolvedValue(claudeJson({ has_marketing_overlay: true, confidence: 0.8 }));
    const res = await classifyProductImage("https://cdn.example.com/pic.jpg");
    expect(res.compliant).toBe(false);
    expect(res.reason).toMatch(/texte marketing/);
  });
});
