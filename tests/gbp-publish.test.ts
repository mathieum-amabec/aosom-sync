import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/gbp-client", () => ({
  createLocalPost: vi.fn(async () => ({ name: "accounts/1/locations/1/localPosts/abc" })),
}));

vi.mock("@/lib/database", () => ({
  getGbpPostById: vi.fn(),
  updateGbpPostStatus: vi.fn(),
  getGbpPosts: vi.fn(),
}));

import { publishPendingGbpPost, hasEverPublished } from "@/lib/gbp-publish";
import { createLocalPost } from "@/lib/gbp-client";
import { getGbpPostById, updateGbpPostStatus, getGbpPosts } from "@/lib/database";

const basePost = {
  id: 1,
  sku: "SKU-1",
  product_type: "Meubles",
  signal_type: "stock",
  summary_fr: "texte",
  cta_url: "https://ameublodirect.ca/products/x",
  image_url: null,
  velocity_score: 5,
  price_drop_score: 0,
  judge_score: 85,
  judge_reasons: "ok",
  status: "pending_review",
  gbp_post_name: null,
  error_message: null,
  created_at: 0,
  published_at: null,
};

beforeEach(() => {
  vi.mocked(getGbpPostById).mockReset();
  vi.mocked(updateGbpPostStatus).mockReset();
  vi.mocked(getGbpPosts).mockReset();
  vi.mocked(createLocalPost).mockClear();
});

describe("publishPendingGbpPost — first-post gate", () => {
  it("refuses to publish the very first post without confirmFirstPost", async () => {
    vi.mocked(getGbpPostById).mockResolvedValue({ ...basePost });
    vi.mocked(getGbpPosts).mockResolvedValue([]); // nothing published yet

    const outcome = await publishPendingGbpPost(1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("needs_first_post_confirmation");
    expect(createLocalPost).not.toHaveBeenCalled();
  });

  it("publishes the first post when confirmFirstPost is true", async () => {
    vi.mocked(getGbpPostById).mockResolvedValue({ ...basePost });
    vi.mocked(getGbpPosts).mockResolvedValue([]);

    const outcome = await publishPendingGbpPost(1, { confirmFirstPost: true });
    expect(outcome.ok).toBe(true);
    expect(createLocalPost).toHaveBeenCalledTimes(1);
    expect(updateGbpPostStatus).toHaveBeenCalledWith(1, "published", expect.objectContaining({ gbpPostName: expect.any(String) }));
  });

  it("does not require confirmFirstPost once a post has already published", async () => {
    vi.mocked(getGbpPostById).mockResolvedValue({ ...basePost, id: 2 });
    vi.mocked(getGbpPosts).mockResolvedValue([{ ...basePost, status: "published" }]);

    const outcome = await publishPendingGbpPost(2);
    expect(outcome.ok).toBe(true);
    expect(createLocalPost).toHaveBeenCalledTimes(1);
  });

  it("rejects a post that isn't pending_review or approved", async () => {
    vi.mocked(getGbpPostById).mockResolvedValue({ ...basePost, status: "rejected" });
    vi.mocked(getGbpPosts).mockResolvedValue([{ ...basePost, status: "published" }]);

    const outcome = await publishPendingGbpPost(1, { confirmFirstPost: true });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("wrong_status");
    expect(createLocalPost).not.toHaveBeenCalled();
  });

  it("marks the post failed and surfaces the error when the API call throws", async () => {
    vi.mocked(getGbpPostById).mockResolvedValue({ ...basePost });
    vi.mocked(getGbpPosts).mockResolvedValue([{ ...basePost, status: "published" }]);
    vi.mocked(createLocalPost).mockRejectedValueOnce(new Error("GBP API not configured"));

    const outcome = await publishPendingGbpPost(1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("publish_failed");
    expect(updateGbpPostStatus).toHaveBeenCalledWith(1, "failed", expect.objectContaining({ errorMessage: expect.any(String) }));
  });
});

describe("hasEverPublished", () => {
  it("reflects whether getGbpPosts('published') returns anything", async () => {
    vi.mocked(getGbpPosts).mockResolvedValueOnce([]);
    expect(await hasEverPublished()).toBe(false);

    vi.mocked(getGbpPosts).mockResolvedValueOnce([{ ...basePost, status: "published" }]);
    expect(await hasEverPublished()).toBe(true);
  });
});
