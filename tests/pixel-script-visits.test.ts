import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import vm from "node:vm";

// First visit vs return (src/lib/visitor-tracking.ts): one beacon per visit to /api/pixel/visit, a new visit after
// 30 min without a page view, ATC / checkout flagged once, and nothing that can break the storefront or the Meta pixel.

async function loadScript(): Promise<string> {
  vi.stubEnv("NEXT_PUBLIC_META_PIXEL_ID", "214720653324969");
  const { GET } = await import("@/app/api/pixel/script/route");
  const res = await GET(new Request("https://outils.ameublodirect.ca/api/pixel/script"));
  return res.text();
}

interface Opts { storage?: Map<string, string> | "throws" | "none"; ua?: string; consent?: boolean; referrer?: string; href?: string }

function run(script: string, o: Opts = {}) {
  const beacons: Array<{ url: string; body: Record<string, unknown> }> = [];
  const docListeners: Record<string, Array<(ev: unknown) => void>> = {};
  const store = o.storage instanceof Map ? o.storage : new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
  };
  const win: Record<string, unknown> = {
    fetch: vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ item_count: 0, attributes: {} }) })),
    ShopifyAnalytics: { meta: { page: { pageType: "home" } } },
    Shopify: { currency: { active: "CAD", rate: "1" }, ...(o.consent === false ? { customerPrivacy: { analyticsProcessingAllowed: () => false } } : {}) },
    location: { href: o.href ?? "https://ameublodirect.ca/?utm_source=facebook&fbclid=abc", search: "" },
    navigator: { userAgent: o.ua ?? "Mozilla/5.0 (iPhone)", sendBeacon: (u: string, b: string) => { beacons.push({ url: u, body: JSON.parse(b) }); return true; } },
    addEventListener: () => {},
    crypto: { getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 255; return a; } },
    Uint8Array,
    setTimeout,
    clearTimeout,
  };
  if (o.storage === "throws") Object.defineProperty(win, "localStorage", { get() { throw new Error("SecurityError"); } });
  else if (o.storage !== "none") win.localStorage = localStorage;
  win.window = win;
  const document = {
    cookie: "",
    referrer: o.referrer ?? "",
    readyState: "loading",
    addEventListener: (k: string, fn: (ev: unknown) => void) => { (docListeners[k] ||= []).push(fn); },
    dispatchEvent: () => true,
    createElement: () => ({}),
    querySelector: () => null,
    getElementsByTagName: () => [{ parentNode: { insertBefore: () => {} } }],
  };
  Object.assign(win, { document, JSON, Date, Math, RegExp, String, Array, Promise, decodeURIComponent, Event: class {} });
  vm.runInNewContext(script, win);
  const visits = () => beacons.filter((b) => b.url.endsWith("/api/pixel/visit")).map((b) => b.body);
  const click = (matches: boolean) => (docListeners.click || []).forEach((fn) => fn({ target: { closest: () => (matches ? {} : null) } }));
  return { win, beacons, visits, store, click };
}

describe("pixel script — first visit vs return", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-16T15:00:00Z")); vi.resetModules(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("sends visit 1 to its own endpoint on the script's host, and the Meta PageView is unchanged", async () => {
    const s = run(await loadScript(), { referrer: "https://l.facebook.com/l.php?u=x" });
    const v = s.visits();
    expect(v).toHaveLength(1);
    expect(s.beacons.find((b) => b.url.endsWith("/api/pixel/visit"))!.url).toBe("https://outils.ameublodirect.ca/api/pixel/visit");
    expect(v[0]).toMatchObject({ t: "visit", n: 1, u: "https://ameublodirect.ca/?utm_source=facebook&fbclid=abc", r: "https://l.facebook.com/l.php?u=x" });
    expect(v[0].p).toBeUndefined();
    expect(String(v[0].v)).toMatch(/^[0-9a-f]{32}$/);
    // PageView still goes to fbq and to the CAPI relay.
    expect((s.win.fbq as { queue: unknown[][] }).queue.map((c) => Array.from(c).slice(0, 2))).toContainEqual(["track", "PageView"]);
    expect(s.beacons.some((b) => b.url.endsWith("/api/capi/event") && b.body.event_name === "PageView")).toBe(true);
  });

  it("keeps the same visit within 30 minutes and counts a return after that, with the days since the last view", async () => {
    const script = await loadScript();
    const storage = new Map<string, string>();
    const a = run(script, { storage });
    vi.setSystemTime(new Date("2026-11-16T15:20:00Z"));
    const b = run(script, { storage });
    expect(b.visits()).toEqual([]);
    vi.setSystemTime(new Date("2026-11-18T15:20:00Z"));
    const c = run(script, { storage });
    expect(c.visits()).toHaveLength(1);
    expect(c.visits()[0]).toMatchObject({ t: "visit", n: 2, v: a.visits()[0].v, g: 2 });
  });

  it("flags an id that predates counting (from the teasers) so its first counted visit is not read as new", async () => {
    const storage = new Map([["lc_vid", "abcdefabcdefabcdef12"]]);
    const s = run(await loadScript(), { storage });
    expect(s.visits()[0]).toMatchObject({ v: "abcdefabcdefabcdef12", n: 1, p: 1 });
  });

  it("flags an add to cart once per page", async () => {
    const s = run(await loadScript());
    (s.win.fetch as (u: string, i: unknown) => unknown)("/cart/add.js", { method: "POST", body: '{"id":"123"}' });
    vi.setSystemTime(new Date("2026-11-16T15:00:05Z"));
    (s.win.fetch as (u: string, i: unknown) => unknown)("/cart/add.js", { method: "POST", body: '{"id":"123"}' });
    expect(s.visits().filter((b) => b.t === "atc")).toEqual([{ t: "atc", v: s.visits()[0].v, n: 1 }]);
  });

  it("flags checkout once per page", async () => {
    const s = run(await loadScript());
    s.click(false);
    s.click(true);
    s.click(true);
    expect(s.visits().filter((b) => b.t === "checkout")).toEqual([{ t: "checkout", v: s.visits()[0].v, n: 1 }]);
  });

  it("stays silent for bots, refused analytics, and blocked or missing storage — and the pixel still runs", async () => {
    const script = await loadScript();
    for (const o of [{ ua: "Mozilla/5.0 (compatible; Googlebot/2.1)" }, { consent: false }, { storage: "throws" as const }, { storage: "none" as const }]) {
      const s = run(script, o);
      expect(s.visits()).toEqual([]);
      expect(s.win.__lcVisit).toBeUndefined();
      expect(s.beacons.some((b) => b.url.endsWith("/api/capi/event"))).toBe(true);
    }
  });
});
