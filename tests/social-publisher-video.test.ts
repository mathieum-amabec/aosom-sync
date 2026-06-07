import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/facebook-client", () => ({
  publishVideo: vi.fn().mockResolvedValue({ id: "vid1", postId: "vid1" }),
  publishWithImage: vi.fn().mockResolvedValue({ id: "img1", postId: "img1" }),
  publishWithImages: vi.fn().mockResolvedValue({ id: "alb1", postId: "alb1" }),
  publishText: vi.fn().mockResolvedValue({ id: "txt1", postId: "txt1" }),
}));
vi.mock("@/lib/instagram-client", () => ({ publishPhoto: vi.fn().mockResolvedValue({ id: "ig1", creationId: "c1" }) }));
vi.mock("@/lib/database", () => ({
  getFacebookDraft: vi.fn(),
  setDraftChannelState: vi.fn(),
  updateFacebookDraft: vi.fn(),
}));
vi.mock("@/lib/config", () => ({
  CHANNEL_META: { fb_ameublo: { platform: "facebook", brand: "ameublo", language: "FR" } },
}));

import { publishDraftToChannel } from "@/lib/social-publisher";
import { publishVideo, publishWithImage } from "@/lib/facebook-client";
import { getFacebookDraft } from "@/lib/database";

const baseDraft = {
  id: 1, sku: "ABC", triggerType: "new_product", language: "FR",
  postText: "FR caption", postTextEn: "EN caption",
  imageUrl: "https://cdn/a.jpg", imageUrls: ["https://cdn/a.jpg"], imagePath: null,
  videoUrl: null as string | null, channels: {},
};

describe("publishDraftToChannel — video preference (Facebook)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("publishes the video when draft.videoUrl is set", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue({ ...baseDraft, videoUrl: "https://cdn/v.mp4" } as never);
    const state = await publishDraftToChannel(1, "fb_ameublo" as never);
    expect(state.status).toBe("published");
    expect(publishVideo).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: "https://cdn/v.mp4", brand: "ameublo", caption: "FR caption" }));
    expect(publishWithImage).not.toHaveBeenCalled();
  });

  it("falls back to the image when there is no video", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue({ ...baseDraft, videoUrl: null } as never);
    const state = await publishDraftToChannel(1, "fb_ameublo" as never);
    expect(state.status).toBe("published");
    expect(publishWithImage).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: "https://cdn/a.jpg" }));
    expect(publishVideo).not.toHaveBeenCalled();
  });
});
