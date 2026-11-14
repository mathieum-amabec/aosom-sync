/**
 * Publishes a stored gbp_posts row to the real Google Business Profile API. Kept separate
 * from gbp-post-generator.ts (content only, never touches the network side) so it's obvious
 * from the import graph which module can actually make something go live.
 *
 * The FIRST EVER publish always requires `confirmFirstPost: true` explicitly, regardless of
 * GBP_AUTO_PUBLISH — Mat asked to see and confirm the very first real post before anything
 * publishes unattended. After that first success, GBP_AUTO_PUBLISH (+ the judge score
 * threshold) governs subsequent weeks.
 */
import { createLocalPost } from "./gbp-client";
import { getGbpPostById, updateGbpPostStatus, getGbpPosts } from "./database";

export type PublishOutcome =
  | { ok: true; postName: string }
  | { ok: false; reason: "not_found" | "wrong_status" | "needs_first_post_confirmation" | "publish_failed"; detail?: string };

export async function hasEverPublished(): Promise<boolean> {
  const published = await getGbpPosts("published", 1);
  return published.length > 0;
}

export async function publishPendingGbpPost(
  id: number,
  opts: { confirmFirstPost?: boolean } = {},
): Promise<PublishOutcome> {
  const post = await getGbpPostById(id);
  if (!post) return { ok: false, reason: "not_found" };
  if (post.status !== "pending_review" && post.status !== "approved") {
    return { ok: false, reason: "wrong_status", detail: `current status: ${post.status}` };
  }

  if (!(await hasEverPublished()) && !opts.confirmFirstPost) {
    return { ok: false, reason: "needs_first_post_confirmation" };
  }

  try {
    const result = await createLocalPost({
      summary: post.summary_fr,
      actionUrl: post.cta_url,
      imageUrl: post.image_url || undefined,
    });
    await updateGbpPostStatus(id, "published", { gbpPostName: result.name });
    return { ok: true, postName: result.name };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await updateGbpPostStatus(id, "failed", { errorMessage: detail });
    return { ok: false, reason: "publish_failed", detail };
  }
}
