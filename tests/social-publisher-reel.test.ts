import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/facebook-client", () => ({
  publishWithImage: vi.fn().mockResolvedValue({ id: "img1", postId: "img1" }),
  publishWithImages: vi.fn().mockResolvedValue({ id: "alb1", postId: "alb1" }),
  publishText: vi.fn().mockResolvedValue({ id: "txt1", postId: "txt1" }),
  publishVideo: vi.fn().mockResolvedValue({ id: "vid1", postId: "vid1" }),
}));
vi.mock("@/lib/instagram-client", () => ({
  publishPhoto: vi.fn().mockResolvedValue({ id: "igphoto1", creationId: "c1" }),
  publishReel: vi.fn().mockResolvedValue({ id: "igreel1", creationId: "c2" }),
}));
vi.mock("@/lib/database", () => ({
  getFacebookDraft: vi.fn(),
  setDraftChannelState: vi.fn(),
  updateFacebookDraft: vi.fn(),
}));
vi.mock("@/lib/config", () => ({
  CHANNEL_META: { ig_ameublo: { platform: "instagram", brand: "ameublo", language: "FR" } },
}));

import { publishDraftToChannel } from "@/lib/social-publisher";
import { publishPhoto, publishReel } from "@/lib/instagram-client";
import { getFacebookDraft } from "@/lib/database";

const baseDraft = {
  id: 1, sku: "ABC", triggerType: "new_product", language: "FR",
  postText: "FR caption", postTextEn: "EN caption",
  imageUrl: "https://cdn/a.jpg", imageUrls: ["https://cdn/a.jpg"], imagePath: null,
  videoUrl: null as string | null, reelsVideoUrl: null as string | null, channels: {},
};

describe("publishDraftToChannel — Instagram Reel preference", () => {
  beforeEach(() => vi.clearAllMocks());

  it("publishes a Reel using the 9:16 reelsVideoUrl when present", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue({ ...baseDraft, reelsVideoUrl: "https://cdn/reel.mp4", videoUrl: "https://cdn/sq.mp4" } as never);
    const state = await publishDraftToChannel(1, "ig_ameublo" as never);
    expect(state.status).toBe("published");
    expect(publishReel).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: "https://cdn/reel.mp4", brand: "ameublo" }));
    expect(publishPhoto).not.toHaveBeenCalled();
  });

  it("falls back to the square videoUrl as a Reel when no 9:16 reel exists", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue({ ...baseDraft, reelsVideoUrl: null, videoUrl: "https://cdn/sq.mp4" } as never);
    const state = await publishDraftToChannel(1, "ig_ameublo" as never);
    expect(state.status).toBe("published");
    expect(publishReel).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: "https://cdn/sq.mp4" }));
  });

  it("falls back to a photo when there is no video at all", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue({ ...baseDraft, reelsVideoUrl: null, videoUrl: null } as never);
    const state = await publishDraftToChannel(1, "ig_ameublo" as never);
    expect(state.status).toBe("published");
    expect(publishPhoto).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: "https://cdn/a.jpg" }));
    expect(publishReel).not.toHaveBeenCalled();
  });
});
