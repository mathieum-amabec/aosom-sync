import { env, META } from "./config";

/**
 * Instagram Graph API wrapper for Business account publishing.
 *
 * Instagram requires a PUBLIC image_url (Meta's servers fetch it).
 * Unlike Facebook, it does NOT accept binary uploads. So we pass the Aosom CDN
 * product image URL directly (already public) rather than the composed /tmp image.
 *
 * Publish flow is two-step:
 *   1. POST /{ig_user_id}/media  → returns creation_id
 *   2. POST /{ig_user_id}/media_publish → publishes the container → returns media_id
 */

export type InstagramBrand = "ameublo" | "furnish";

export interface InstagramPublishResult {
  id: string;      // media id (the published post)
  creationId: string; // container id used for the publish step
}

interface BrandCreds {
  igUserId: string;
  token: string;
  label: string;
}

function brandCreds(brand: InstagramBrand): BrandCreds {
  if (brand === "ameublo") {
    return {
      igUserId: env.instagramAmeubloAccountId,
      // IG uses the Page Access Token of the linked Facebook Page
      token: env.facebookAmeubloPageToken,
      label: "Instagram Ameublo Direct",
    };
  }
  if (brand === "furnish") {
    const igId = process.env.INSTAGRAM_FURNISH_ACCOUNT_ID;
    if (!igId) throw new Error("INSTAGRAM_FURNISH_ACCOUNT_ID not configured yet");
    return { igUserId: igId, token: env.facebookFurnishPageToken, label: "Instagram Furnish Direct" };
  }
  throw new Error(`Unknown Instagram brand: ${brand}`);
}

/**
 * Test the Instagram connection by fetching account info.
 */
export async function testConnection(brand: InstagramBrand = "ameublo"): Promise<{ username: string; id: string; brand: InstagramBrand }> {
  const { igUserId, token } = brandCreds(brand);
  const res = await fetch(`${META.GRAPH_API_URL}/${igUserId}?fields=username,id`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(`${brand}: ${data.error.message}`);
  return { username: data.username, id: data.id, brand };
}

/**
 * Publish a photo post to an Instagram Business account.
 * imageUrl MUST be publicly accessible (Meta fetches it server-side).
 *
 * Note: Instagram caption limit is 2200 characters, up to 30 hashtags.
 */
export async function publishPhoto(opts: {
  caption: string;
  imageUrl: string;
  brand: InstagramBrand;
}): Promise<InstagramPublishResult> {
  const { igUserId, token, label } = brandCreds(opts.brand);

  // Instagram caps captions at 2200 chars; trim defensively
  const caption = opts.caption.length > 2200 ? opts.caption.slice(0, 2197) + "..." : opts.caption;

  // Step 1: Create media container
  const createRes = await fetch(`${META.GRAPH_API_URL}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ image_url: opts.imageUrl, caption }),
  });

  if (createRes.status === 429) {
    throw new Error(`${label}: Instagram rate limit, retry later`);
  }

  const createData = await createRes.json();
  if (createData.error) throw new Error(`${label} (create): ${createData.error.message}`);
  const creationId: string = createData.id;
  if (!creationId) throw new Error(`${label}: no creation_id returned`);

  // Step 2: Publish the container
  const publishRes = await fetch(`${META.GRAPH_API_URL}/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ creation_id: creationId }),
  });

  const publishData = await publishRes.json();
  if (publishData.error) throw new Error(`${label} (publish): ${publishData.error.message}`);
  return { id: publishData.id, creationId };
}
