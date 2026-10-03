import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({ CLAUDE: { MODEL_BATCH: "claude-cheap", MODEL: "claude-strong" } }));

const { llmModel, isGeminiEnabled } = await import("@/lib/llm-models");

const KEYS = ["GEMINI_API_KEY", "LLM_PROVIDER", "GEMINI_LITE_MODEL", "GEMINI_STRONG_MODEL"] as const;
beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe("llmModel", () => {
  it("falls back to the historical Claude batch model when no Gemini key is configured (bare clone, tests)", () => {
    expect(isGeminiEnabled()).toBe(false);
    expect(llmModel("lite")).toBe("claude-cheap");
    expect(llmModel("strong")).toBe("claude-cheap");
  });

  it("uses the two Gemini tiers as soon as GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "k";
    expect(llmModel("lite")).toBe("gemini-3.5-flash-lite");
    expect(llmModel("strong")).toBe("gemini-3.8-flash");
  });

  it("LLM_PROVIDER=anthropic is the one-switch rollback, even with a key", () => {
    process.env.GEMINI_API_KEY = "k";
    process.env.LLM_PROVIDER = "anthropic";
    expect(llmModel("lite")).toBe("claude-cheap");
    expect(llmModel("strong")).toBe("claude-cheap");
  });

  it("LLM_PROVIDER=gemini forces Gemini; tiers are overridable per deploy", () => {
    process.env.LLM_PROVIDER = "gemini";
    process.env.GEMINI_LITE_MODEL = "gemini-x-lite";
    process.env.GEMINI_STRONG_MODEL = "gemini-x-strong";
    expect(llmModel("lite")).toBe("gemini-x-lite");
    expect(llmModel("strong")).toBe("gemini-x-strong");
  });
});
