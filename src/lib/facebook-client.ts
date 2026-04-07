import fs from "fs";
import { env, FACEBOOK } from "./config";
import { resolveImagePath } from "./image-composer";

/**
 * Facebook Graph API wrapper for page post publishing.
 * Uses native fetch — no SDK dependency.
 */

export interface PublishResult {
  id: string;
  postId: string;
}

/**
 * Test the Facebook connection by fetching page info.
 */
export async function testConnection(): Promise<{ name: string; id: string }> {
  const res = await fetch(`${FACEBOOK.GRAPH_API_URL}/${env.facebookPageId}?fields=name,id`, {
    headers: { Authorization: `Bearer ${env.facebookPageAccessToken}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { name: data.name, id: data.id };
}

/**
 * Publish a post with an image to the Facebook page.
 * Uploads the image from a local file path.
 */
export async function publishWithImage(opts: {
  caption: string;
  imagePath: string;
  scheduledAt?: number; // Unix timestamp for scheduled publish
}): Promise<PublishResult> {
  const pageId = env.facebookPageId;
  const token = env.facebookPageAccessToken;

  const absPath = resolveImagePath(opts.imagePath);
  if (!fs.existsSync(absPath)) throw new Error(`Image not found: ${absPath}`);

  const formData = new FormData();
  const imageBuffer = fs.readFileSync(absPath);
  formData.append("source", new Blob([imageBuffer], { type: "image/jpeg" }), "image.jpg");
  formData.append("message", opts.caption);
  formData.append("access_token", token);

  if (opts.scheduledAt) {
    formData.append("published", "false");
    formData.append("scheduled_publish_time", String(opts.scheduledAt));
  }

  const res = await fetch(`${FACEBOOK.GRAPH_API_URL}/${pageId}/photos`, {
    method: "POST",
    body: formData,
  });

  if (res.status === 429) {
    throw new Error("Facebook rate limit — try again later");
  }

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { id: data.id, postId: data.post_id || data.id };
}

/**
 * Publish a text-only post (with optional link).
 */
export async function publishText(opts: {
  message: string;
  link?: string;
  scheduledAt?: number;
}): Promise<PublishResult> {
  const pageId = env.facebookPageId;
  const token = env.facebookPageAccessToken;

  const body: Record<string, string> = {
    message: opts.message,
    access_token: token,
  };
  if (opts.link) body.link = opts.link;
  if (opts.scheduledAt) {
    body.published = "false";
    body.scheduled_publish_time = String(opts.scheduledAt);
  }

  const res = await fetch(`${FACEBOOK.GRAPH_API_URL}/${pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    throw new Error("Facebook rate limit — try again later");
  }

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { id: data.id, postId: data.id };
}
