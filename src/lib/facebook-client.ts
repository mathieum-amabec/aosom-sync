import { env, FACEBOOK } from "./config";

/**
 * Facebook Graph API wrapper for multi-brand Page publishing.
 * Uses native fetch — no SDK dependency.
 *
 * Brand selection: pass `brand: "ameublo" | "furnish"` to pick which Page to publish to.
 * Each brand resolves to its own Page ID + Page Access Token from env.
 *
 * Image upload: we pass a public image URL to the Graph API `/photos` endpoint.
 * Meta fetches the image server-side. We DO NOT upload binaries because Vercel
 * serverless /tmp is per-instance and ephemeral — the file written during
 * `generate` is not reachable from the `publish` request. Same mechanism as IG.
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
 * imageUrl MUST be a public HTTP URL — Meta fetches it server-side.
 *
 * Historically this function read the composed image from /tmp and uploaded
 * binary. That broke on Vercel because /tmp is per-serverless-instance:
 * the file written during `generate` doesn't exist when `publish` runs.
 * Now we pass a URL and let Meta pull the image.
 */
export async function publishWithImage(opts: {
  caption: string;
  imageUrl: string;
  brand: FacebookBrand;
  scheduledAt?: number;
}): Promise<PublishResult> {
  const { pageId, token, label } = brandCreds(opts.brand);

  const body: Record<string, string> = {
    url: opts.imageUrl,
    message: opts.caption,
  };
  if (opts.scheduledAt) {
    body.published = "false";
    body.scheduled_publish_time = String(opts.scheduledAt);
  }

  const res = await fetch(`${FACEBOOK.GRAPH_API_URL}/${pageId}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    throw new Error(`${label}: Facebook rate limit, retry later`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`${label}: ${data.error.message}`);
  return { id: data.id, postId: data.post_id || data.id };
}

/**
 * Publish a multi-photo album/carousel to a brand's Facebook Page.
 *
 * Flow (per Meta Graph API docs):
 *   1. Upload each photo unpublished via POST /{page-id}/photos with published=false,
 *      collecting the returned photo IDs.
 *   2. Create the feed post via POST /{page-id}/feed with message + attached_media[]
 *      referencing those IDs. Facebook renders the result as an album.
 *
 * Rate limit: 500ms delay between uploads (Meta throttles rapid /photos POSTs).
 *
 * Partial failure: if at least one upload succeeds, publishes the feed post with
 * whatever media IDs were collected. Throws only when every upload fails.
 */
export async function publishWithImages(opts: {
  caption: string;
  imageUrls: string[];
  brand: FacebookBrand;
  scheduledAt?: number;
}): Promise<PublishResult> {
  if (opts.imageUrls.length === 0) {
    throw new Error("publishWithImages requires at least one image URL");
  }
  if (opts.imageUrls.length === 1) {
    return publishWithImage({
      caption: opts.caption,
      imageUrl: opts.imageUrls[0],
      brand: opts.brand,
      scheduledAt: opts.scheduledAt,
    });
  }

  const { pageId, token, label } = brandCreds(opts.brand);
  const mediaFbids: string[] = [];
  const uploadErrors: string[] = [];

  for (let i = 0; i < opts.imageUrls.length; i++) {
    const url = opts.imageUrls[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${FACEBOOK.GRAPH_API_URL}/${pageId}/photos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url, published: "false" }),
      });
      if (res.status === 429) {
        uploadErrors.push(`photo ${i + 1}: rate limited`);
        continue;
      }
      const data = await res.json();
      if (data.error) {
        uploadErrors.push(`photo ${i + 1}: ${data.error.message}`);
        continue;
      }
      if (data.id) mediaFbids.push(String(data.id));
    } catch (err) {
      uploadErrors.push(`photo ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (mediaFbids.length === 0) {
    throw new Error(`${label}: all ${opts.imageUrls.length} photo uploads failed — ${uploadErrors.join("; ")}`);
  }

  // Graph API with Content-Type: application/json expects attached_media as a native array.
  // Bracket-notation keys (attached_media[0]) only work with form-urlencoded bodies.
  const feedBody: Record<string, unknown> = {
    message: opts.caption,
    attached_media: mediaFbids.map((id) => ({ media_fbid: id })),
  };
  if (opts.scheduledAt) {
    feedBody.published = "false";
    feedBody.scheduled_publish_time = String(opts.scheduledAt);
  }

  const feedRes = await fetch(`${FACEBOOK.GRAPH_API_URL}/${pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(feedBody),
  });
  if (feedRes.status === 429) {
    throw new Error(`${label}: Facebook rate limit on /feed, retry later`);
  }
  const feedData = await feedRes.json();
  if (feedData.error) throw new Error(`${label}: ${feedData.error.message}`);

  console.log(
    `[PUBLISH] ${label} multi-photo album posted with ${mediaFbids.length}/${opts.imageUrls.length} photos (media_fbids: ${mediaFbids.join(",")})${uploadErrors.length > 0 ? ` — partial: ${uploadErrors.join("; ")}` : ""}`
  );

  return { id: feedData.id, postId: feedData.id };
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
