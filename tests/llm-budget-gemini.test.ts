/**
 * budgetedCreate routes a `gemini-*` model to Google and answers in the Anthropic Message shape,
 * so every existing caller keeps working when its model constant is switched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { addDailyLlmTokens, getDailyLlmTokensUsed } = vi.hoisted(() => ({
  addDailyLlmTokens: vi.fn().mockResolvedValue(undefined),
  getDailyLlmTokensUsed: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/database", () => ({ addDailyLlmTokens, getDailyLlmTokensUsed }));

const { geminiGenerate } = vi.hoisted(() => ({ geminiGenerate: vi.fn() }));
vi.mock("@/lib/gemini-client", () => ({ geminiGenerate }));

const { budgetedCreate, isGeminiModel } = await import("@/lib/llm-budget");

const anthropicCreate = vi.fn();
const client = { messages: { create: anthropicCreate } } as never;

beforeEach(() => {
  anthropicCreate.mockReset();
  geminiGenerate.mockReset();
  addDailyLlmTokens.mockClear();
  delete process.env.GEMINI_THINKING_LEVEL;
});

describe("isGeminiModel", () => {
  it("matches google ids only", () => {
    expect(isGeminiModel("gemini-3.5-flash-lite")).toBe(true);
    expect(isGeminiModel("claude-haiku-4-5")).toBe(false);
  });
});

describe("budgetedCreate with a gemini model", () => {
  it("sends system + text/image messages to Gemini and returns an Anthropic-shaped message", async () => {
    geminiGenerate.mockResolvedValue({
      text: '{"ok":true}', finishReason: "STOP", content: null, functionCalls: [],
      usage: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 5 },
    });
    const msg = await budgetedCreate(
      client,
      {
        model: "gemini-3.5-flash-lite",
        max_tokens: 400,
        system: "SYS",
        messages: [
          { role: "user", content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
            { type: "text", text: "Classifie." },
          ] },
          { role: "assistant", content: "ok" },
          { role: "user", content: "encore" },
        ],
      },
      undefined,
      "maintenance",
    );

    expect(anthropicCreate).not.toHaveBeenCalled();
    const [params, pool] = geminiGenerate.mock.calls[0];
    expect(pool).toBe("maintenance");
    expect(params).toMatchObject({ model: "gemini-3.5-flash-lite", systemInstruction: "SYS", maxOutputTokens: 400, thinkingLevel: "minimal" });
    expect(params.contents).toEqual([
      { role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: "QUJD" } }, { text: "Classifie." }] },
      { role: "model", parts: [{ text: "ok" }] },
      { role: "user", parts: [{ text: "encore" }] },
    ]);

    expect(msg.content).toEqual([{ type: "text", text: '{"ok":true}', citations: null }]);
    expect(msg.usage).toMatchObject({ input_tokens: 120, output_tokens: 35 }); // thought tokens are billed as output
    expect(msg.stop_reason).toBe("end_turn");
  });

  it("does not double-count tokens (geminiGenerate already records them)", async () => {
    geminiGenerate.mockResolvedValue({ text: "x", finishReason: "STOP", content: null, functionCalls: [], usage: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    await budgetedCreate(client, { model: "gemini-3.5-flash-lite", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(addDailyLlmTokens).not.toHaveBeenCalled();
  });

  it("maps a truncated answer to stop_reason max_tokens and an empty answer to no content", async () => {
    geminiGenerate.mockResolvedValue({ text: "", finishReason: "MAX_TOKENS", content: null, functionCalls: [], usage: null });
    const msg = await budgetedCreate(client, { model: "gemini-3.5-flash-lite", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(msg.stop_reason).toBe("max_tokens");
    expect(msg.content).toEqual([]);
  });

  it("joins an array system prompt and honours GEMINI_THINKING_LEVEL", async () => {
    process.env.GEMINI_THINKING_LEVEL = "low";
    geminiGenerate.mockResolvedValue({ text: "x", finishReason: "STOP", content: null, functionCalls: [], usage: null });
    await budgetedCreate(client, {
      model: "gemini-3.8-flash", max_tokens: 10,
      system: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(geminiGenerate.mock.calls[0][0]).toMatchObject({ systemInstruction: "A\nB", thinkingLevel: "low" });
  });

  it("rejects content it cannot translate instead of silently dropping it", async () => {
    await expect(
      budgetedCreate(client, {
        model: "gemini-3.5-flash-lite", max_tokens: 10,
        messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/y.jpg" } }] }],
      }),
    ).rejects.toThrow(/unsupported content block/);
  });

  it("leaves a claude model on the Anthropic path", async () => {
    anthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "c" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await budgetedCreate(client, { model: "claude-haiku-4-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(geminiGenerate).not.toHaveBeenCalled();
  });
});

describe("Gemini thinking level is chosen per model", () => {
  const level = async (model: string) => {
    geminiGenerate.mockResolvedValue({ text: "x", finishReason: "STOP", content: null, functionCalls: [], usage: null });
    await budgetedCreate(client, { model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    return geminiGenerate.mock.calls.at(-1)![0].thinkingLevel;
  };
  it("Flash-Lite uses minimal; any other Gemini (e.g. 3.8 Flash) uses low because it rejects minimal", async () => {
    expect(await level("gemini-3.5-flash-lite")).toBe("minimal");
    expect(await level("gemini-3.1-flash-lite")).toBe("minimal");
    expect(await level("gemini-3.8-flash")).toBe("low");
  });
  it("GEMINI_THINKING_LEVEL overrides both defaults but is never forced to minimal", async () => {
    process.env.GEMINI_THINKING_LEVEL = "high";
    expect(await level("gemini-3.5-flash-lite")).toBe("high");
    expect(await level("gemini-3.8-flash")).toBe("high");
    process.env.GEMINI_THINKING_LEVEL = "minimal";
    expect(await level("gemini-3.8-flash")).toBe("low");
  });
});
