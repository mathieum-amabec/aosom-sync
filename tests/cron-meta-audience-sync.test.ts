import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({
  env: { cronSecret: "test-secret-123", metaAdAccountId: undefined },
}));
vi.mock("@/lib/meta-ads-client", () => ({ ensureCoreRemarketingAudiences: vi.fn() }));
vi.mock("@/lib/database", () => ({ recordCronRun: vi.fn() }));

import { GET } from "@/app/api/cron/meta-audience-sync/route";
import { ensureCoreRemarketingAudiences } from "@/lib/meta-ads-client";
import { recordCronRun } from "@/lib/database";

const runMock = vi.mocked(ensureCoreRemarketingAudiences);
const recMock = vi.mocked(recordCronRun);
const auth = (s = "test-secret-123") =>
  new Request("https://app.test/api/cron/meta-audience-sync", { headers: { Authorization: `Bearer ${s}` } });

const RESULT = {
  visitors30d: { id: "aud_v", name: "Visiteurs 30 jours (pixel)", approximate_count_lower_bound: 900, approximate_count_upper_bound: 1000 },
  addToCart30d: { id: "aud_c", name: "Ajouts au panier 30 jours (pixel)", approximate_count_lower_bound: 90, approximate_count_upper_bound: 100 },
  viewContent14d: { id: "aud_p", name: "Vues produit 14 jours (pixel)", approximate_count_lower_bound: 400, approximate_count_upper_bound: 500 },
};

describe("GET /api/cron/meta-audience-sync", () => {
  beforeEach(() => {
    runMock.mockReset().mockResolvedValue(RESULT);
    recMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns 401 and does nothing without auth", async () => {
    const res = await GET(new Request("https://app.test/api/cron/meta-audience-sync"));
    expect(res.status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
    expect(recMock).not.toHaveBeenCalled();
  });

  it("ensures the three audiences and records their sizes on success", async () => {
    const res = await GET(auth());
    expect(res.status).toBe(200);
    expect(runMock).toHaveBeenCalledWith("act_20658834");
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.visitors30d.id).toBe("aud_v");
    expect(recMock).toHaveBeenCalledWith(
      "meta-audience-sync",
      "success",
      expect.stringContaining("visitors30d=aud_v(900-1000)"),
    );
  });

  it("records an error run and returns 500 when the ensure call throws", async () => {
    runMock.mockRejectedValue(new Error("Meta API down"));
    const res = await GET(auth());
    expect(res.status).toBe(500);
    expect(recMock).toHaveBeenCalledWith("meta-audience-sync", "error", "Meta API down");
  });
});
