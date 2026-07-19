/**
 * Kling AI image→video engine (https://klingai.com).
 *
 * Turns a product's best still photo into a short cinematic clip, then runs it
 * through the FFmpeg branding pass (navy band + logo) to produce a final 9:16
 * MP4 for Reels/Shorts.
 *
 * Pipeline (generateKlingVideo):
 *   1. pick the product's best image
 *   2. generate a cinematic prompt via Claude (templated fallback if Claude is off)
 *   3. POST /v1/videos/image2video → task id
 *   4. poll getKlingVideoStatus(taskId) until it succeeds/fails or 5min elapses
 *   5. download the raw clip
 *   6. brand it with FFmpeg (best-effort) → outputPath
 *
 * No-ops to null when KLING_API_KEY is unset, so the pipeline can call it
 * unconditionally and simply skip the Kling engine when it isn't configured —
 * same contract as the Creatomate engine.
 */
import fs from "node:fs";
import path from "node:path";
import { env, CLAUDE } from "../config";
import { getAnthropicClient } from "../content-generator";
import { budgetedCreate } from "@/lib/llm-budget";
import { applyBrandOverlay } from "./ffmpeg-brand";
import type { VideoLocale } from "./video-brand";

const KLING_API = "https://api.klingai.com/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 5 * 60_000; // 5 min — Kling renders a 5s clip in ~1-3min

/** Minimal product shape the engine needs — name drives the prompt, images the source frame. */
export interface KlingProduct {
  name: string;
  images: string[];
  sku?: string;
}

export interface GenerateKlingVideoOptions {
  product: KlingProduct;
  locale: VideoLocale;
  /** Absolute path the final branded MP4 is written to. */
  outputPath: string;
}

export type KlingTaskStatus = "processing" | "completed" | "failed" | "unknown";

export interface KlingVideoStatus {
  status: KlingTaskStatus;
  /** Public MP4 url — present once status is "completed". */
  url: string | null;
}

export function isKlingConfigured(): boolean {
  return !!env.klingApiKey;
}

function authHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Pick the best source image for the clip: the first non-empty https URL. Aosom
 * lists the hero/primary photo first, so position order is the right heuristic.
 */
export function selectBestImage(product: KlingProduct): string | null {
  for (const img of product.images ?? []) {
    if (typeof img === "string" && /^https:\/\//i.test(img.trim())) return img.trim();
  }
  return null;
}

/** Deterministic templated prompt — the fallback when Claude isn't available. */
export function fallbackCinematicPrompt(product: KlingProduct): string {
  return `slow cinematic zoom on a ${product.name}, warm interior lighting, lifestyle setting, 4K, professional photography`;
}

/**
 * Ask Claude for a single-line cinematic image→video prompt for this product.
 * Best-effort: any failure (Claude off, network, refusal) falls back to the
 * deterministic template so the engine never blocks on prompt generation.
 */
export async function buildCinematicPrompt(product: KlingProduct, locale: VideoLocale): Promise<string> {
  try {
    const client = getAnthropicClient();
    const langNote = locale === "en" ? "English" : "French";
    const message = await budgetedCreate(client, {
      model: CLAUDE.MODEL,
      max_tokens: 200,
      system:
        "You write concise, single-line cinematic prompts for an AI image-to-video model. " +
        "Describe camera motion, lighting and setting for a short lifestyle product clip. " +
        "Output ONLY the prompt, no quotes or preamble.",
      messages: [
        {
          role: "user",
          content:
            `Product: ${product.name}\n` +
            `Write one cinematic image-to-video prompt (${langNote} market, but keep the prompt in English for the model). ` +
            `Follow this style: "slow cinematic zoom on a [product], warm interior lighting, lifestyle setting, 4K, professional photography".`,
        },
      ],
    });
    const text = message.content[0]?.type === "text" ? message.content[0].text.trim() : "";
    if (text) return text.replace(/^["']|["']$/g, "").split("\n")[0].trim();
  } catch (err) {
    console.warn(`[kling] cinematic prompt fell back to template: ${err instanceof Error ? err.message : err}`);
  }
  return fallbackCinematicPrompt(product);
}

/**
 * Kick off an image→video task. Returns the Kling task id, or null when Kling
 * isn't configured / the API rejects the request (logged, non-throwing).
 */
export async function createImage2VideoTask(opts: {
  imageUrl: string;
  prompt: string;
  durationSeconds?: number;
}): Promise<string | null> {
  const key = env.klingApiKey;
  if (!key) return null;
  try {
    const res = await fetch(`${KLING_API}/videos/image2video`, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({
        image_url: opts.imageUrl,
        prompt: opts.prompt,
        duration: opts.durationSeconds ?? 5,
        aspect_ratio: "9:16",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[kling] createImage2VideoTask ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    // Kling wraps the payload in `data`; tolerate a flat shape too.
    return data?.data?.task_id ?? data?.task_id ?? null;
  } catch (err) {
    console.warn(`[kling] createImage2VideoTask failed: ${err}`);
    return null;
  }
}

/** Poll a Kling task. Returns { status, url } — url is set once completed. */
export async function getKlingVideoStatus(taskId: string): Promise<KlingVideoStatus> {
  const key = env.klingApiKey;
  if (!key) return { status: "unknown", url: null };
  try {
    const res = await fetch(`${KLING_API}/videos/image2video/${encodeURIComponent(taskId)}`, {
      headers: authHeaders(key),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return { status: "unknown", url: null };
    const data = await res.json();
    const taskStatus: string = data?.data?.task_status ?? data?.task_status ?? "";
    const url: string | null =
      data?.data?.task_result?.videos?.[0]?.url ?? data?.task_result?.videos?.[0]?.url ?? null;
    if (taskStatus === "succeed" || taskStatus === "completed") return { status: "completed", url };
    if (taskStatus === "failed") return { status: "failed", url: null };
    return { status: "processing", url: null };
  } catch {
    return { status: "unknown", url: null };
  }
}

/** Poll until the task completes/fails or the budget runs out. Returns the clip url or null. */
async function pollUntilDone(
  taskId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? POLL_TIMEOUT_MS);
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  while (Date.now() < deadline) {
    const { status, url } = await getKlingVideoStatus(taskId);
    if (status === "completed" && url) return url;
    if (status === "failed") return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null; // still rendering — caller skips the video
}

/** Download a remote clip to `dest`. Throws on a non-2xx / network error. */
async function downloadClip(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

/**
 * Generate a branded Kling video for a product. Returns the final MP4 path, or
 * null when the engine no-ops (no key) or can't produce a clip (no image, API
 * failure, render timeout) — the caller then skips the Kling video.
 */
export async function generateKlingVideo(
  options: GenerateKlingVideoOptions,
  poll: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string | null> {
  if (!env.klingApiKey) return null; // no-op when unconfigured

  const { product, locale, outputPath } = options;

  const imageUrl = selectBestImage(product);
  if (!imageUrl) {
    console.warn(`[kling] no usable image for ${product.sku ?? product.name}; skipping`);
    return null;
  }

  const prompt = await buildCinematicPrompt(product, locale);

  const taskId = await createImage2VideoTask({ imageUrl, prompt });
  if (!taskId) return null;

  const clipUrl = await pollUntilDone(taskId, poll);
  if (!clipUrl) return null;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const rawPath = `${outputPath}.raw.mp4`;
  try {
    await downloadClip(clipUrl, rawPath);
  } catch (err) {
    console.warn(`[kling] clip download failed: ${err}`);
    return null;
  }

  const { outputPath: finalPath } = await applyBrandOverlay(rawPath, outputPath, { locale });
  // Drop the intermediate raw clip once branding has produced the final file.
  try {
    if (path.resolve(rawPath) !== path.resolve(finalPath)) fs.unlinkSync(rawPath);
  } catch {
    /* best-effort cleanup */
  }
  return finalPath;
}
