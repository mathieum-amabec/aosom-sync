import fs from "fs";
import { env, FACEBOOK } from "./config";
import { resolveImagePath } from "./image-composer";

/**
 * Facebook Graph API wrapper for multi-brand Page publishing.
 * Uses native fetch — no SDK dependency.
 *
 * Brand selection: pass `brand: "ameublo" | "furnish"` to pick which Page to publish to.
 * Each brand resolves to its own Page ID + Page Access Token from env.
 */

export type FacebookBrand = "ameublo" | "furnish";

export interface PublishResult {
  id: string;
  postId: string;
}

interface BrandCreds {
  pageId: string;
  token: string;
  label: string;
}

function brandCreds(brand: FacebookBrand): BrandCreds {
  if (brand === "ameublo") {
    return { pageId: env.facebookAmeubloPageId, token: env.facebookAmeubloPageToken, label: "Ameublo Direct" };
  }
  if (brand === "furnish") {
    return { pageId: env.facebookFurnishPageId, token: env.facebookFurnishPageToken, label: "Furnish Direct" };
  }
  throw new Error(`Unknown Facebook brand: ${brand}`);
}

/**
 * Test the connection for one brand by fetching page info.
 */
export async function testConnection(brand: FacebookBrand = "ameublo"): Promise<{ name: string; id: string; brand: FacebookBrand }> {
  const { pageId, token } = brandCreds(brand);
  const res = await fetch(`${FACEBOOK.GRAPH_API_URL}/${pageId}?fields=name,id`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(`${brand}: ${data.error.message}`);
  return { name: data.name, id: data.id, brand };
}

/**
 * Publish a post with an image to a brand's Facebook Page.
 */
export async function publishWithImage(opts: {
  caption: string;
  imagePath: string;
  brand: FacebookBrand;
  scheduledAt?: number;
}): Promise<PublishResult> {
  const { pageId, token, label } = brandCreds(opts.brand);

  const absPath = resolveImagePath(opts.imagePath);
  if (!fs.existsSync(absPath)) throw new Error(`Image not found: ${absPath}`);

  const formData = new FormData();
  const imageBuffer = fs.readFileSync(absPath);
  formData.append("source", new Blob([imageBuffer], { type: "image/jpeg" }), "image.jpg");
  formData.append("message", opts.caption);

  if (opts.scheduledAt) {
    formData.append("published", "false");
    formData.append("scheduled_publish_time", String(opts.scheduledAt));
  }

  const res = await fetch(`${FACEBOOK.GRAPH_API_URL}/${pageId}/photos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (res.status === 429) {
    throw new Error(`${label}: Facebook rate limit, retry later`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`${label}: ${data.error.message}`);
  return { id: data.id, postId: data.post_id || data.id };
}

/**
 * Publish a text-only post (with optional link) to a brand's Facebook Page.
 */
export async function publishText(opts: {
  message: string;
  brand: FacebookBrand;
  link?: string;
  scheduledAt?: number;
}): Promise<PublishResult> {
  const { pageId, token, label } = brandCreds(opts.brand);

  const body: Record<string, string> = { message: opts.message };
  if (opts.link) body.link = opts.link;
  if (opts.scheduledAt) {
    body.published = "false";
    body.scheduled_publish_time = String(opts.scheduledAt);
  }

  const res = await fetch(`${FACEBOOK.GRAPH_API_URL}/${pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    throw new Error(`${label}: Facebook rate limit, retry later`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`${label}: ${data.error.message}`);
  return { id: data.id, postId: data.id };
}
