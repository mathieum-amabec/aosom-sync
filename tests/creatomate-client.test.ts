import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({ env: { creatomateApiKey: "ck_test" } }));

import { env } from "@/lib/config";
import {
  createVideoFromTemplate,
  getVideoStatus,
  renderVideoAndWait,
  isCreatomateConfigured,
  createReelsVideo,
  renderReelsVideoAndWait,
  isReelsConfigured,
} from "@/lib/creatomate-client";

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  (env as { creatomateApiKey?: string }).creatomateApiKey = "ck_test";
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("createVideoFromTemplate", () => {
  it("POSTs to /v1/renders with auth + body, returns the render id", async () => {
    fetchMock.mockResolvedValueOnce(json(200, [{ id: "r1", status: "planned" }]));
    const id = await createVideoFromTemplate("tmpl_1", { product_title: "Chair", price: "9.99 $" });
    expect(id).toBe("r1");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.creatomate.com/v1/renders");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer ck_test");
    const body = JSON.parse(opts.body);
    expect(body.template_id).toBe("tmpl_1");
    expect(body.modifications).toEqual({ product_title: "Chair", price: "9.99 $" });
  });

  it("no-ops to null when no API key", async () => {
    (env as { creatomateApiKey?: string }).creatomateApiKey = undefined;
    expect(isCreatomateConfigured()).toBe(false);
    expect(await createVideoFromTemplate("t", {})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(json(402, { error: "quota" }));
    expect(await createVideoFromTemplate("t", {})).toBeNull();
  });
});

describe("getVideoStatus", () => {
  it("GETs the render and returns status + url", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: "r1", status: "succeeded", url: "https://cdn/v.mp4" }));
    const s = await getVideoStatus("r1");
    expect(s).toEqual({ status: "succeeded", url: "https://cdn/v.mp4" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.creatomate.com/v1/renders/r1");
  });
  it("returns unknown without a key (no call)", async () => {
    (env as { creatomateApiKey?: string }).creatomateApiKey = undefined;
    expect(await getVideoStatus("r1")).toEqual({ status: "unknown", url: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("renderVideoAndWait", () => {
  const route = (impl: (url: string, opts: { method?: string }) => Response) =>
    fetchMock.mockImplementation((url: string, opts: { method?: string } = {}) => Promise.resolve(impl(url, opts)));

  it("returns the url once the render succeeds", async () => {
    route((url, opts) => {
      if (url.endsWith("/v1/renders") && opts.method === "POST") return json(200, [{ id: "r1", status: "planned" }]);
      return json(200, { id: "r1", status: "succeeded", url: "https://cdn/v.mp4" });
    });
    const r = await renderVideoAndWait("t", {}, { timeoutMs: 1000, intervalMs: 5 });
    expect(r).toEqual({ jobId: "r1", url: "https://cdn/v.mp4" });
  });

  it("returns null url when the render fails", async () => {
    route((url, opts) => {
      if (url.endsWith("/v1/renders") && opts.method === "POST") return json(200, [{ id: "r1", status: "planned" }]);
      return json(200, { id: "r1", status: "failed", url: null });
    });
    const r = await renderVideoAndWait("t", {}, { timeoutMs: 1000, intervalMs: 5 });
    expect(r).toEqual({ jobId: "r1", url: null });
  });

  it("returns null when the create step no-ops (no key)", async () => {
    (env as { creatomateApiKey?: string }).creatomateApiKey = undefined;
    expect(await renderVideoAndWait("t", {})).toEqual({ jobId: null, url: null });
  });
});

describe("createReelsVideo / renderReelsVideoAndWait (9:16)", () => {
  type E = { creatomateApiKey?: string; creatomateReelsTemplateId?: string };
  afterEach(() => { (env as E).creatomateReelsTemplateId = undefined; });

  it("isReelsConfigured is true only with key + reels template", () => {
    (env as E).creatomateApiKey = "ck_test";
    (env as E).creatomateReelsTemplateId = undefined;
    expect(isReelsConfigured()).toBe(false);
    (env as E).creatomateReelsTemplateId = "tmpl_reel";
    expect(isReelsConfigured()).toBe(true);
  });

  it("createReelsVideo POSTs with the reels template id", async () => {
    (env as E).creatomateApiKey = "ck_test";
    (env as E).creatomateReelsTemplateId = "tmpl_reel";
    fetchMock.mockResolvedValueOnce(json(200, [{ id: "rr1", status: "planned" }]));
    const id = await createReelsVideo({ product_title: "Chair" });
    expect(id).toBe("rr1");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).template_id).toBe("tmpl_reel");
  });

  it("createReelsVideo no-ops to null when no reels template configured", async () => {
    (env as E).creatomateApiKey = "ck_test";
    (env as E).creatomateReelsTemplateId = undefined;
    expect(await createReelsVideo({})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renderReelsVideoAndWait returns the url once the reel render succeeds", async () => {
    (env as E).creatomateApiKey = "ck_test";
    (env as E).creatomateReelsTemplateId = "tmpl_reel";
    fetchMock.mockImplementation((url: string, opts: { method?: string } = {}) =>
      Promise.resolve(
        url.endsWith("/v1/renders") && opts.method === "POST"
          ? json(200, [{ id: "rr1", status: "planned" }])
          : json(200, { id: "rr1", status: "succeeded", url: "https://cdn/reel.mp4" }),
      ),
    );
    const r = await renderReelsVideoAndWait({}, { timeoutMs: 1000, intervalMs: 5 });
    expect(r).toEqual({ jobId: "rr1", url: "https://cdn/reel.mp4" });
  });

  it("renderReelsVideoAndWait no-ops when no reels template", async () => {
    (env as E).creatomateApiKey = "ck_test";
    (env as E).creatomateReelsTemplateId = undefined;
    expect(await renderReelsVideoAndWait({})).toEqual({ jobId: null, url: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
