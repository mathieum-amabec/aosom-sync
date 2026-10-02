import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * gemini-client.ts — the budget-gated Gemini call behind the storefront assistant and the
 * video frame QC (2026-10-02). What matters: the daily cap is checked BEFORE the call, the
 * call's tokens land in the same daily_llm_budget counter, and the model turn comes back in a
 * shape the tool loop can push back verbatim (thought signatures intact).
 */

const assertLlmBudget = vi.hoisted(() => vi.fn());
const addDailyLlmTokens = vi.hoisted(() => vi.fn());
vi.mock("@/lib/llm-budget", () => ({ assertLlmBudget }));
vi.mock("@/lib/database", () => ({ addDailyLlmTokens }));
vi.mock("@/lib/config", () => ({ env: { geminiApiKey: "k" } }));

import { geminiGenerate, __setGeminiFetcherForTests } from "@/lib/gemini-client";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  assertLlmBudget.mockResolvedValue(undefined);
  addDailyLlmTokens.mockResolvedValue(undefined);
  __setGeminiFetcherForTests(fetchMock as unknown as typeof fetch);
});
afterEach(() => __setGeminiFetcherForTests(null));

describe("geminiGenerate", () => {
  it("checks the pool budget first, then records the call's total tokens", async () => {
    fetchMock.mockResolvedValue(ok({
      candidates: [{ content: { role: "model", parts: [{ text: '{"a":1}' }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
    }));
    const r = await geminiGenerate({ model: "gemini-3.5-flash-lite", contents: [{ role: "user", parts: [{ text: "hi" }] }] }, "video");
    expect(assertLlmBudget).toHaveBeenCalledWith("video");
    expect(addDailyLlmTokens).toHaveBeenCalledWith("video", 120);
    expect(r.text).toBe('{"a":1}');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/models/gemini-3.5-flash-lite:generateContent");
    expect(JSON.parse(init.body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
  });

  it("never calls the API when the budget is spent", async () => {
    assertLlmBudget.mockRejectedValue(new Error("budget"));
    await expect(geminiGenerate({ model: "m", contents: [] }, "assistant")).rejects.toThrow("budget");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns function calls and keeps the model turn (with its thought signature) intact", async () => {
    const parts = [{ functionCall: { name: "search_catalog", args: { query: "sofa" }, id: "c1" }, thoughtSignature: "sig" }];
    fetchMock.mockResolvedValue(ok({ candidates: [{ content: { role: "model", parts } }], usageMetadata: { totalTokenCount: 10 } }));
    const r = await geminiGenerate({ model: "m", contents: [], tools: [{ name: "search_catalog", description: "d", parameters: {} }] }, "assistant");
    expect(r.functionCalls).toEqual([{ name: "search_catalog", args: { query: "sofa" }, id: "c1" }]);
    expect(r.content).toEqual({ role: "model", parts });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tools).toEqual([
      { functionDeclarations: [{ name: "search_catalog", description: "d", parameters: {} }] },
    ]);
  });

  it("retries once on a 5xx, never on a 4xx", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 503 })).mockResolvedValueOnce(ok({ candidates: [] }));
    await geminiGenerate({ model: "m", contents: [] }, "assistant");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset().mockResolvedValue(new Response("bad", { status: 400 }));
    await expect(geminiGenerate({ model: "m", contents: [] }, "assistant")).rejects.toThrow("Gemini API 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops thought parts from the text", async () => {
    fetchMock.mockResolvedValue(ok({ candidates: [{ content: { role: "model", parts: [{ text: "pensée", thought: true }, { text: "réponse" }] } }] }));
    const r = await geminiGenerate({ model: "m", contents: [] }, "assistant");
    expect(r.text).toBe("réponse");
  });
});
