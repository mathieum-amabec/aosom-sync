/**
 * Budget-gated Gemini `generateContent` client.
 *
 * Moved onto Gemini 3.5 Flash-Lite on 2026-10-02 (Mat's call, after a cost review):
 *   - the public storefront assistant (was Haiku 4.5 — ~15.5M tokens/30 days, the biggest
 *     LLM line; Flash-Lite is $0.30/$2.50 per MTok vs Haiku's $1/$5);
 *   - the video-batch frame QC (was Sonnet 4.6, $3/$15). On the strict lifestyle-photo
 *     prompt Gemini agreed with Sonnet on 91/91 picks (2026-10-02 autumn pass).
 *
 * Same spend guardrail as `budgetedCreate` (llm-budget.ts): the pool's daily cap is asserted
 * BEFORE the call (fail-closed, LlmBudgetExceededError) and the call's total tokens are
 * recorded AFTER, into the same `daily_llm_budget` counters — so the usage dashboard and the
 * caps keep working whichever provider a pool runs on.
 *
 * Uses the stable `models/{model}:generateContent` REST endpoint (function calling, system
 * instruction, inline images). Gemini 3 function calls carry a `thoughtSignature`: callers
 * must push the model's returned `content` back VERBATIM into the next turn's `contents`.
 */
import { env } from "@/lib/config";
import { assertLlmBudget, type BudgetPool } from "@/lib/llm-budget";
import { addDailyLlmTokens } from "@/lib/database";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 2;

/** One part of a Gemini message. Only the fields we use are typed; the rest pass through. */
export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  thoughtSignature?: string;
  thought?: boolean;
  [key: string]: unknown;
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiResult {
  /** The model's turn, to push back verbatim into `contents` (keeps thought signatures). */
  content: GeminiContent | null;
  /** Concatenated non-thought text parts. */
  text: string;
  functionCalls: Array<{ name: string; args: Record<string, unknown>; id?: string }>;
  finishReason: string | null;
  usage: GeminiUsage | null;
}

export class GeminiApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Gemini API ${status}: ${body.slice(0, 300)}`);
    this.name = "GeminiApiError";
  }
}

export interface GeminiGenerateParams {
  model: string;
  contents: GeminiContent[];
  systemInstruction?: string;
  tools?: GeminiFunctionDeclaration[];
  maxOutputTokens?: number;
  /** Gemini 3 thinking depth. "minimal" keeps latency and billed thought tokens near zero. */
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
}

type Fetcher = typeof fetch;
let fetcher: Fetcher = (...args) => fetch(...args);

/** Test-only: swap the HTTP layer (null restores global fetch). */
export function __setGeminiFetcherForTests(fn: Fetcher | null): void {
  fetcher = fn ?? ((...args) => fetch(...args));
}

async function post(model: string, body: unknown): Promise<Record<string, unknown>> {
  const apiKey = env.geminiApiKey;
  if (!apiKey) throw new Error("Gemini: GEMINI_API_KEY not set");
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetcher(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
      const text = await res.text();
      lastErr = new GeminiApiError(res.status, text);
      // Retry only what a retry can fix: rate limit and server-side errors.
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      lastErr =
        err instanceof Error && err.name === "AbortError"
          ? new Error(`Gemini: timeout after ${TIMEOUT_MS / 1000}s`)
          : err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt + 1 < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Budget-gated `generateContent`. Throws LlmBudgetExceededError when the pool is spent. */
export async function geminiGenerate(params: GeminiGenerateParams, pool: BudgetPool): Promise<GeminiResult> {
  await assertLlmBudget(pool);
  const body: Record<string, unknown> = {
    contents: params.contents,
    generationConfig: {
      maxOutputTokens: params.maxOutputTokens ?? 1024,
      thinkingConfig: { thinkingLevel: params.thinkingLevel ?? "minimal" },
    },
  };
  if (params.systemInstruction) body.systemInstruction = { parts: [{ text: params.systemInstruction }] };
  if (params.tools?.length) body.tools = [{ functionDeclarations: params.tools }];

  const json = await post(params.model, body);
  const usage = (json.usageMetadata as GeminiUsage | undefined) ?? null;
  const total = usage?.totalTokenCount ?? (usage?.promptTokenCount ?? 0) + (usage?.candidatesTokenCount ?? 0);
  if (total > 0) {
    try {
      await addDailyLlmTokens(pool, total);
    } catch (err) {
      // Same rule as budgetedCreate: bookkeeping never fails a paid-for call, but never silently.
      console.error(
        `[gemini] UNRECORDED SPEND — failed to write ${total} token(s) to pool "${pool}": ` +
          `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      );
    }
  }

  const candidate = (json.candidates as Array<Record<string, unknown>> | undefined)?.[0];
  const content = (candidate?.content as GeminiContent | undefined) ?? null;
  const parts = content?.parts ?? [];
  return {
    content: content ? { role: "model", parts } : null,
    text: parts
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("")
      .trim(),
    functionCalls: parts
      .filter((p) => p.functionCall?.name)
      .map((p) => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {}, id: p.functionCall!.id })),
    finishReason: typeof candidate?.finishReason === "string" ? candidate.finishReason : null,
    usage,
  };
}

/** A JPEG/PNG buffer as an inline image part. */
export function imagePart(data: Buffer, mimeType = "image/jpeg"): GeminiPart {
  return { inlineData: { mimeType, data: data.toString("base64") } };
}
