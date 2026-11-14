import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import vm from "node:vm";

// 2026-11-12 mobile perf: fbevents.js loads on the first interaction or 1.5 s after the load event, never during the
// initial render; PageView is queued in fbq right away and relayed to the CAPI endpoint with the same event_id.

async function loadScript(): Promise<string> {
  vi.stubEnv("NEXT_PUBLIC_META_PIXEL_ID", "214720653324969");
  const { GET } = await import("@/app/api/pixel/script/route");
  const res = await GET(new Request("https://aosom-sync.vercel.app/api/pixel/script"));
  return res.text();
}

function run(script: string) {
  const inserted: Array<{ src?: string }> = [];
  const winListeners: Record<string, Array<() => void>> = {};
  const beacons: string[] = [];
  const win: Record<string, unknown> = {
    fetch: vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ item_count: 0, attributes: {} }) })),
    ShopifyAnalytics: { meta: { page: { pageType: "home" } } },
    Shopify: { currency: { active: "CAD", rate: "1" } },
    location: { href: "https://ameublodirect.ca/", search: "" },
    navigator: { sendBeacon: (_u: string, b: string) => { beacons.push(b); return true; } },
    addEventListener: (k: string, fn: () => void) => { (winListeners[k] ||= []).push(fn); },
    setTimeout,
    clearTimeout,
  };
  win.window = win;
  const document = {
    cookie: "",
    readyState: "loading",
    addEventListener: () => {},
    dispatchEvent: () => true,
    createElement: () => ({}),
    getElementsByTagName: () => [{ parentNode: { insertBefore: (t: { src?: string }) => { inserted.push(t); } } }],
  };
  // The context object IS window (as in a browser): the loader writes window.fbq and later code calls bare fbq().
  Object.assign(win, { document, JSON, Date, Math, RegExp, String, Promise, decodeURIComponent, Event: class {} });
  vm.runInNewContext(script, win);
  const fire = (k: string) => (winListeners[k] || []).forEach((fn) => fn());
  return { win, inserted, beacons, fire };
}

describe("pixel script — lazy fbevents.js", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("does not load the SDK during the initial render, then loads it 1.5 s after the load event", async () => {
    const s = run(await loadScript());
    expect(s.inserted).toEqual([]);
    const q = (s.win.fbq as { queue: unknown[][] }).queue;
    expect(q.map((c) => Array.from(c).slice(0, 2))).toEqual([["init", "214720653324969"], ["track", "PageView"]]);
    s.fire("load");
    await vi.advanceTimersByTimeAsync(1400);
    expect(s.inserted).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(s.inserted).toHaveLength(1);
    expect(s.inserted[0].src).toBe("https://connect.facebook.net/en_US/fbevents.js");
  });

  it("loads it at once on the first interaction, only once", async () => {
    const s = run(await loadScript());
    s.fire("pointerdown");
    s.fire("scroll");
    s.fire("load");
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.inserted).toHaveLength(1);
  });

  it("relays PageView server-side with the same event id as the browser event", async () => {
    const s = run(await loadScript());
    const pv = (s.win.fbq as { queue: unknown[][] }).queue.find((c) => c[1] === "PageView")!;
    const relayed = s.beacons.map((b) => JSON.parse(b)).find((b) => b.event_name === "PageView");
    expect(relayed).toBeTruthy();
    expect(relayed.event_id).toBe((pv[3] as { eventID: string }).eventID);
  });
});
