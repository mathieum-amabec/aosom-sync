import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/cron-tracking", () => ({ trackCron: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock("@/lib/referral/deps", () => ({ defaultReferralDeps: vi.fn(() => ({})) }));
vi.mock("@/lib/referral/credits", () => ({ runReferralCredits: vi.fn() }));

import { GET } from "@/app/api/cron/referral-credits/route";
import { runReferralCredits } from "@/lib/referral/credits";

const req = (q = "", auth = true) => new Request(`https://x/api/cron/referral-credits${q}`, auth ? { headers: { authorization: "Bearer s3cret" } } : {});

describe("GET /api/cron/referral-credits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
    vi.mocked(runReferralCredits).mockResolvedValue({
      mode: "off", ordersSeen: 0, alreadyDecided: 0, decisions: [], credited: 0, rejected: 0, waiting: 0, failed: 0, notifyFailed: 0, rechecked: 0, revoked: 0, stuckPending: 0,
    });
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("401 without the cron secret", async () => {
    expect((await GET(req("", false))).status).toBe(401);
    expect(runReferralCredits).not.toHaveBeenCalled();
  });
  it("no ?mode → the setting decides (mode undefined)", async () => {
    expect((await GET(req())).status).toBe(200);
    expect(vi.mocked(runReferralCredits).mock.calls[0][0].mode).toBeUndefined();
  });
  it("?mode=dry overrides for one call; junk is ignored", async () => {
    await GET(req("?mode=dry"));
    expect(vi.mocked(runReferralCredits).mock.calls[0][0].mode).toBe("dry");
    await GET(req("?mode=yolo"));
    expect(vi.mocked(runReferralCredits).mock.calls[1][0].mode).toBeUndefined();
  });
  it("500 on failure", async () => {
    vi.mocked(runReferralCredits).mockRejectedValueOnce(new Error("boom"));
    expect((await GET(req())).status).toBe(500);
  });
});
