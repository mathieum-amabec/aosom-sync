import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /api/revalidate: Bearer CRON_SECRET, busts the shared 'feeds' Data Cache tag
// and revalidates each feed route path. next/cache is mocked so we assert the calls.

const revalidateTag = vi.fn();
const revalidatePath = vi.fn();

function mockDeps(secret: string | undefined = "test-secret") {
  vi.doMock("next/cache", () => ({ revalidateTag, revalidatePath }));
  vi.doMock("@/lib/config", () => ({
    env: {
      get cronSecret() {
        if (secret === undefined) throw new Error("CRON_SECRET not set");
        return secret;
      },
    },
  }));
}

function req(auth?: string) {
  return new Request("http://localhost/api/revalidate", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

async function post(r: Request) {
  const mod = await import("@/app/api/revalidate/route");
  return mod.POST(r);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("POST /api/revalidate", () => {
  it("401 without an Authorization header — no revalidation", async () => {
    mockDeps();
    const res = await post(req());
    expect(res.status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("401 with the wrong secret", async () => {
    mockDeps("test-secret");
    const res = await post(req("Bearer wrong-secret-value"));
    expect(res.status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("401 (not 500) when CRON_SECRET is unconfigured", async () => {
    mockDeps(undefined);
    const res = await post(req("Bearer anything"));
    expect(res.status).toBe(401);
  });

  it("busts the 'feeds' tag and every feed path with the correct secret", async () => {
    mockDeps("test-secret");
    const res = await post(req("Bearer test-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      revalidated: true,
      feeds: ["google", "pinterest", "pinterest-en", "meta", "meta-xml"],
    });
    expect(revalidateTag).toHaveBeenCalledWith("feeds", "max");
    expect(revalidatePath).toHaveBeenCalledTimes(5);
    for (const feed of ["google", "pinterest", "pinterest-en", "meta", "meta-xml"]) {
      expect(revalidatePath).toHaveBeenCalledWith(`/api/feeds/${feed}`);
    }
  });
});
