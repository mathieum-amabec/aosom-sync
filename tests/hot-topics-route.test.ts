import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({ env: { cronSecret: "s3cret" } }));
const run = vi.fn();
vi.mock("@/lib/hot-topics/run", () => ({ runHotTopics: (...a: unknown[]) => run(...a) }));
vi.mock("@/lib/database", () => ({ recordCronRun: vi.fn() }));

import { GET } from "@/app/api/cron/hot-topics/route";
import { recordCronRun } from "@/lib/database";

const req = (qs = "", auth = "s3cret") =>
  new Request(`https://app.test/api/cron/hot-topics${qs}`, { headers: { Authorization: `Bearer ${auth}` } });

describe("GET /api/cron/hot-topics", () => {
  beforeEach(() => { run.mockReset().mockResolvedValue({ mode: "off", skipped: "hot_topics_mode=off" }); vi.mocked(recordCronRun).mockClear(); });

  it("401 without the cron secret", async () => {
    expect((await GET(req("", "nope"))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it("runs with no override by default and records a cron_runs line", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledWith({});
    expect(recordCronRun).toHaveBeenCalledWith("hot-topics", "success", "off: hot_topics_mode=off");
  });
  it("?dry=1 downgrades to dry", async () => {
    await GET(req("?dry=1"));
    expect(run).toHaveBeenCalledWith({ modeOverride: "dry" });
  });
  it("500 + error run when the pipeline throws", async () => {
    run.mockRejectedValue(new Error("boom"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(recordCronRun).toHaveBeenCalledWith("hot-topics", "error", "boom");
  });
});
