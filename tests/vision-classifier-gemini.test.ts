/**
 * classifyProductImageGemini — the cheaper, gallery-wide sibling of classifyProductImage.
 * Same validated STRICT_OVERLAY_PROMPT and ImageClassification contract, calling Google's
 * Gemini API directly (Interactions API) instead of Anthropic. Direct, not via Vercel AI
 * Gateway: Google's own API has a genuine free tier at this volume (2026-10-01 decision).
 * Separate test file: this function needs GEMINI_API_KEY, not the Anthropic SDK, so it gets
 * its own config mock rather than sharing vision-classifier.test.ts's Claude-focused one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let geminiApiKey: string | undefined = "test-gemini-key";
vi.mock("@/lib/config", () => ({
  env: {
    get geminiApiKey() { return geminiApiKey; },
  },
  CLAUDE: { MODEL: "claude-sonnet-4-6", MODEL_BATCH: "claude-haiku-4-5", MAX_TOKENS_CONTENT: 1000, MAX_TOKENS_SOCIAL: 500 },
}));

const { classifyProductImageGemini, GEMINI_CLASSIFY_PX } = await import("@/lib/vision-classifier");

/** A response shaped like the real Interactions API: a reasoning step (ignored) followed by
 *  the model's actual output step. */
function geminiReply(obj: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: "v1_test",
      status: "completed",
      steps: [
        { type: "thought", signature: "irrelevant" },
        { type: "model_output", content: [{ type: "text", text: JSON.stringify(obj) }] },
      ],
    }),
  };
}

beforeEach(() => {
  geminiApiKey = "test-gemini-key";
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string | URL | Request) => {
    // downloadBase64's own fetch, for the image bytes — only hit when the URL isn't the
    // Gemini API endpoint itself.
    if (!String(url).startsWith("https://generativelanguage.googleapis.com")) {
      return Promise.resolve({ ok: true, arrayBuffer: async () => new TextEncoder().encode("fake-image-bytes").buffer });
    }
    return Promise.resolve(geminiReply({ has_marketing_overlay: false, confidence: 1, reason: "ok" }));
  }));
});

describe("classifyProductImageGemini", () => {
  it("returns compliant=true for a clean image", async () => {
    vi.mocked(fetch).mockImplementation((url: string | URL | Request) =>
      String(url).startsWith("https://generativelanguage")
        ? Promise.resolve(geminiReply({ has_marketing_overlay: false, confidence: 0.9, reason: "image propre" }) as never)
        : Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as never),
    );
    const res = await classifyProductImageGemini("https://cdn.example.com/pic.jpg");
    expect(res).toEqual({ compliant: true, reason: "image propre", confidence: 0.9 });
  });

  it("returns compliant=false when marketing/measurement overlay is detected", async () => {
    vi.mocked(fetch).mockImplementation((url: string | URL | Request) =>
      String(url).startsWith("https://generativelanguage")
        ? Promise.resolve(geminiReply({ has_marketing_overlay: true, confidence: 0.85, reason: "dimensions superposées" }) as never)
        : Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as never),
    );
    const res = await classifyProductImageGemini("https://cdn.example.com/dims.jpg");
    expect(res.compliant).toBe(false);
    expect(res.reason).toBe("dimensions superposées");
  });

  it("calls generativelanguage.googleapis.com's interactions endpoint with the x-goog-api-key header, the gemini-3.5-flash-lite model, and the shared prompt", async () => {
    await classifyProductImageGemini("https://cdn.example.com/pic.jpg");

    const call = vi.mocked(fetch).mock.calls.find(([u]) => String(u).startsWith("https://generativelanguage"));
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect((init as RequestInit).headers).toMatchObject({ "x-goog-api-key": "test-gemini-key" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gemini-3.5-flash-lite");
    expect(body.input[0]).toEqual({ type: "text", text: expect.stringContaining("TEXTE MARKETING INCRUSTÉ") });
    const imgPart = body.input.find((p: { type: string }) => p.type === "image");
    expect(imgPart.mime_type).toBe("image/jpeg");
    expect(typeof imgPart.data).toBe("string"); // base64, not a bare URL
  });

  it("downloads the 384x384 resized variant of a Shopify CDN url — the flat-rate Gemini tile", async () => {
    expect(GEMINI_CLASSIFY_PX).toBe(384);
    await classifyProductImageGemini("https://cdn.shopify.com/s/files/1/pic.jpg?v=1");

    const downloadCall = vi.mocked(fetch).mock.calls.find(([u]) => !String(u).startsWith("https://generativelanguage"));
    expect(downloadCall?.[0]).toBe("https://cdn.shopify.com/s/files/1/pic_384x384.jpg?v=1");
  });

  it("only reads the model_output step's text, ignoring any thought steps", async () => {
    vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
      if (!String(url).startsWith("https://generativelanguage")) return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as never);
      return Promise.resolve({
        ok: true,
        json: async () => ({
          steps: [
            { type: "thought", signature: "x" }, // no content array at all — must not crash
            { type: "model_output", content: [{ type: "text", text: '{"has_marketing_overlay": false, "reason": "ok"}' }] },
          ],
        }),
      } as never);
    });
    const res = await classifyProductImageGemini("https://cdn.example.com/pic.jpg");
    expect(res.compliant).toBe(true);
  });

  it("throws when GEMINI_API_KEY is not set — never silently skips or falls back", async () => {
    geminiApiKey = undefined;
    await expect(classifyProductImageGemini("https://cdn.example.com/pic.jpg")).rejects.toThrow(/GEMINI_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on an empty url", async () => {
    await expect(classifyProductImageGemini("")).rejects.toThrow(/empty imageUrl/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws when Google responds with a non-OK status (e.g. the real 402 prepay-depleted case)", async () => {
    vi.mocked(fetch).mockImplementation((url: string | URL | Request) =>
      String(url).startsWith("https://generativelanguage")
        ? Promise.resolve({ ok: false, status: 402, text: async () => "Your prepayment credits are depleted" } as never)
        : Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as never),
    );
    await expect(classifyProductImageGemini("https://cdn.example.com/pic.jpg")).rejects.toThrow(/Gemini 402/);
  });

  it("throws when the reply has no JSON (never a false compliant)", async () => {
    vi.mocked(fetch).mockImplementation((url: string | URL | Request) =>
      String(url).startsWith("https://generativelanguage")
        ? Promise.resolve({ ok: true, json: async () => ({ steps: [{ type: "model_output", content: [{ type: "text", text: "désolé" }] }] }) } as never)
        : Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as never),
    );
    await expect(classifyProductImageGemini("https://cdn.example.com/pic.jpg")).rejects.toThrow(/no JSON/);
  });

  it("throws when has_marketing_overlay is missing/non-boolean", async () => {
    vi.mocked(fetch).mockImplementation((url: string | URL | Request) =>
      String(url).startsWith("https://generativelanguage")
        ? Promise.resolve(geminiReply({ confidence: 0.5, reason: "ambigu" }) as never)
        : Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as never),
    );
    await expect(classifyProductImageGemini("https://cdn.example.com/pic.jpg")).rejects.toThrow(/has_marketing_overlay/);
  });

  it("falls back to a default reason when the model omits one", async () => {
    vi.mocked(fetch).mockImplementation((url: string | URL | Request) =>
      String(url).startsWith("https://generativelanguage")
        ? Promise.resolve(geminiReply({ has_marketing_overlay: true, confidence: 0.6 }) as never)
        : Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as never),
    );
    const res = await classifyProductImageGemini("https://cdn.example.com/pic.jpg");
    expect(res.reason).toMatch(/texte marketing/);
  });

  it("clamps an out-of-range confidence into 0..1", async () => {
    vi.mocked(fetch).mockImplementation((url: string | URL | Request) =>
      String(url).startsWith("https://generativelanguage")
        ? Promise.resolve(geminiReply({ has_marketing_overlay: false, confidence: 1.4, reason: "ok" }) as never)
        : Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as never),
    );
    const res = await classifyProductImageGemini("https://cdn.example.com/pic.jpg");
    expect(res.confidence).toBe(1);
  });
});
