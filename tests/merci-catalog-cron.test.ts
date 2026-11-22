import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/cron-tracking", () => ({ trackCron: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock("@/lib/post-purchase/catalog", () => ({ buildMerciCatalogue: vi.fn() }));
vi.mock("@/lib/post-purchase/store", () => ({ replaceCandidates: vi.fn() }));
vi.mock("@/lib/post-purchase/discount", () => ({ cleanupExpiredMerciCodes: vi.fn() }));

import { GET } from "@/app/api/cron/merci-catalog/route";
import { trackCron } from "@/lib/cron-tracking";
import { buildMerciCatalogue } from "@/lib/post-purchase/catalog";
import { replaceCandidates } from "@/lib/post-purchase/store";
import { cleanupExpiredMerciCodes } from "@/lib/post-purchase/discount";

const req = (q = "") => new Request(`https://x/api/cron/merci-catalog${q}`, { headers: { authorization: "Bearer s3cret" } });

describe("GET /api/cron/merci-catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
    vi.mocked(buildMerciCatalogue).mockResolvedValue({ products: 2, candidates: [] });
    vi.mocked(replaceCandidates).mockResolvedValue(0);
    vi.mocked(cleanupExpiredMerciCodes).mockResolvedValue({ found: 0, deleted: 0 });
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("#13 ?dry=1 writes nothing: no catalogue write, no code delete, no cron tracking row", async () => {
    const res = await GET(req("?dry=1"));
    expect(res.status).toBe(200);
    expect(replaceCandidates).not.toHaveBeenCalled();
    expect(trackCron).not.toHaveBeenCalled();
    expect(cleanupExpiredMerciCodes).toHaveBeenCalledWith({ dryRun: true });
  });
  it("a real run is tracked and writes the catalogue", async () => {
    expect((await GET(req())).status).toBe(200);
    expect(trackCron).toHaveBeenCalled();
    expect(replaceCandidates).toHaveBeenCalled();
  });
  it("401 without the cron secret", async () => {
    expect((await GET(new Request("https://x/api/cron/merci-catalog"))).status).toBe(401);
  });
});
