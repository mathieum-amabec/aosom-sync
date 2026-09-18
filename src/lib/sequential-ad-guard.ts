/**
 * Automatic minimum-quality gate for sequential-ad drafts (publication_queue,
 * content_type='sequential_ad'), so a bulk-approval action never blindly promotes
 * a draft whose content has gone stale since it was rendered — weeks-old batches
 * (the oldest goes back to 2026-07-08) can reference a product that sold out or
 * was un-imported since generation, or a Blob URL that expired.
 *
 * Deterministic checks only, no LLM call in this path (mirrors the philosophy of
 * image-compliance-drift.ts: catch drift cheaply, defer anything that needs
 * judgment to the queue an operator still reviews).
 */
import { getProduct } from "@/lib/database";

export interface SequentialAdQualityInput {
  /** publication_queue.content_id, shape "seqad:<style>:<campaign>:<SKU>". */
  contentId: string;
  caption: string | undefined;
  reelsVideoUrl: string | undefined;
}

export interface SequentialAdQualityResult {
  passes: boolean;
  reasons: string[];
}

const PLACEHOLDER_PATTERNS = [/^undefined$/i, /^null$/i, /\{\{/, /^\s*$/];

/** Extract the SKU from a "seqad:<style>:<campaign>:<SKU>" content_id, or null if malformed. */
export function extractSkuFromContentId(contentId: string): string | null {
  const parts = contentId.split(":");
  if (parts.length < 4 || parts[0] !== "seqad") return null;
  const sku = parts.slice(3).join(":"); // SKUs never contain ':', but join defensively
  return sku.trim() || null;
}

function captionIssue(caption: string | undefined): string | null {
  if (!caption || PLACEHOLDER_PATTERNS.some((re) => re.test(caption.trim()))) {
    return "caption is empty or a placeholder";
  }
  return null;
}

function urlIssue(url: string | undefined): string | null {
  if (!url) return "reelsVideoUrl is missing";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return `reelsVideoUrl is not https (${parsed.protocol})`;
  } catch {
    return "reelsVideoUrl is not a well-formed URL";
  }
  return null;
}

/**
 * HEAD the video URL to confirm it still resolves. Separated so tests can inject a
 * fake — never make a real network call from a unit test. 5s timeout: a bulk check
 * over ~100 rows must not hang on one dead Blob URL.
 */
export async function defaultCheckUrlReachable(url: string): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5_000) });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}

export interface CheckSequentialAdQualityDeps {
  checkUrlReachable?: (url: string) => Promise<{ ok: boolean; status?: number }>;
  lookupProduct?: (sku: string) => Promise<{ qty: number; shopify_product_id: string | null } | null>;
}

export async function checkSequentialAdQuality(
  input: SequentialAdQualityInput,
  deps: CheckSequentialAdQualityDeps = {},
): Promise<SequentialAdQualityResult> {
  const checkUrlReachable = deps.checkUrlReachable ?? defaultCheckUrlReachable;
  const lookupProduct = deps.lookupProduct ?? getProduct;

  const reasons: string[] = [];

  const cIssue = captionIssue(input.caption);
  if (cIssue) reasons.push(cIssue);

  const uIssue = urlIssue(input.reelsVideoUrl);
  if (uIssue) {
    reasons.push(uIssue);
  } else if (input.reelsVideoUrl) {
    const reach = await checkUrlReachable(input.reelsVideoUrl);
    if (!reach.ok) {
      reasons.push(`video URL unreachable${reach.status ? ` (${reach.status})` : ""}`);
    }
  }

  const sku = extractSkuFromContentId(input.contentId);
  if (!sku) {
    reasons.push(`content_id "${input.contentId}" does not match the expected seqad:<style>:<campaign>:<SKU> shape`);
  } else {
    const product = await lookupProduct(sku);
    if (!product) {
      reasons.push(`product ${sku} no longer exists in the catalog`);
    } else {
      if (!product.shopify_product_id) reasons.push(`product ${sku} is no longer imported on Shopify`);
      if (!(product.qty > 0)) reasons.push(`product ${sku} is now out of stock`);
    }
  }

  return { passes: reasons.length === 0, reasons };
}
