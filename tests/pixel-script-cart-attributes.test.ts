import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import vm from "node:vm";

// The storefront script copies _fbp/_fbc to the cart so the orders/paid webhook can send them with the server
// Purchase. It must reach "buy now" (which skips the cart), never write to an empty cart, never rewrite what is
// already there, retry what failed, and never let a failure reach the storefront.

const FBP = "fb.1.1700000000000.1234567890";
const FBC = "fb.1.1700000000000.AbC_dEf-123";
const CHECK_KEY = "_meta_attrs_checked";

async function loadScript(): Promise<string> {
  vi.stubEnv("NEXT_PUBLIC_META_PIXEL_ID", "214720653324969");
  const { GET } = await import("@/app/api/pixel/script/route");
  const res = await GET(new Request("https://aosom-sync.vercel.app/api/pixel/script"));
  return res.text();
}

interface Cart { item_count: number; attributes?: Record<string, string> }
interface StoreOpts {
  cookie?: string; search?: string; cart?: Cart | null; failCart?: boolean; noStorage?: boolean;
  storage?: Map<string, string>; updateOk?: boolean; addDelayMs?: number; readDelayMs?: number; addFails?: boolean;
}
interface Init { method?: string; body?: string; keepalive?: boolean; headers?: Record<string, string> }

function run(script: string, o: StoreOpts) {
  const calls: Array<{ url: string; init?: Init }> = [];
  // A live cart: an add changes what the next /cart.js returns, and only after the add has landed.
  const state = { cart: o.cart === undefined ? { item_count: 0, attributes: {} } : o.cart };
  const pageFetch = vi.fn((url: string, init?: Init) => {
    calls.push({ url, init });
    if (url === "/cart.js") {
      if (o.failCart) return Promise.reject(new Error("network"));
      const snapshot = state.cart; // what a read returns is what the cart held when the request was served
      return new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: () => Promise.resolve(snapshot) }), o.readDelayMs ?? 0));
    }
    if (url === "/cart/update.js") {
      if (o.updateOk === false) return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) });
      if (state.cart) state.cart = { ...state.cart, attributes: { ...state.cart.attributes, ...JSON.parse(init?.body ?? "{}").attributes } };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(state.cart) });
    }
    if (url === "/cart/add.js") {
      if (o.addFails) return Promise.reject(new Error("network"));
      return new Promise((resolve) => setTimeout(() => {
        if (state.cart) state.cart = { ...state.cart, item_count: state.cart.item_count + 1 };
        resolve({ ok: true, json: () => Promise.resolve({}) });
      }, o.addDelayMs ?? 0));
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  const data = o.storage ?? new Map<string, string>();
  const sessionStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
  const win: Record<string, unknown> = {
    fbq: () => {},
    fetch: pageFetch,
    ShopifyAnalytics: { meta: { page: { pageType: "collection" } } },
    Shopify: { currency: { active: "CAD", rate: "1" } },
    location: { href: "https://ameublodirect.ca/", search: o.search ?? "" },
    navigator: { sendBeacon: () => true },
    setTimeout,
    clearTimeout,
  };
  if (!o.noStorage) win.sessionStorage = sessionStorage;
  win.window = win;
  const listeners: Record<string, (ev: unknown) => void> = {};
  const document = {
    cookie: o.cookie ?? "",
    addEventListener: (type: string, fn: (ev: unknown) => void) => { listeners[type] = fn; },
    createElement: () => ({ type: "", name: "", value: "" }),
    getElementsByTagName: () => [{ parentNode: { insertBefore: () => {} } }],
  };
  vm.runInNewContext(script, { ...win, window: win, document, JSON, Date, Math, RegExp, String, Promise, decodeURIComponent, setTimeout, clearTimeout });
  const updates = () => calls.filter((c) => c.url === "/cart/update.js").map((c) => JSON.parse(c.init?.body ?? "{}"));
  const reads = () => calls.filter((c) => c.url === "/cart.js").length;
  const add = () => (win.fetch as (u: string, i: unknown) => Promise<unknown>)("/cart/add.js", { body: "id=333&quantity=1" });
  /** Dispatches the real submit listener on a fake product form; returns the inputs it ended up with. */
  const submit = (existing: Array<{ name: string; value: string }> = []) => {
    const inputs = [...existing];
    const form = {
      action: "https://ameublodirect.ca/cart/add",
      querySelector: (sel: string) => inputs.find((i) => sel.includes(`"${i.name}"`)) ?? null,
      appendChild: (el: { name: string; value: string }) => { inputs.push(el); },
    };
    listeners.submit({ target: form, defaultPrevented: false });
    return inputs;
  };
  return { win, calls, updates, reads, add, submit, data, state };
}

const COOKIES = `_fbp=${FBP}; _fbc=${FBC}`;
const CART: Cart = { item_count: 2, attributes: {} };
const EMPTY: Cart = { item_count: 0, attributes: {} };

describe("pixel script: cart attributes on page load", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("writes both values to a cart that has items, as JSON, surviving navigation", async () => {
    const s = run(await loadScript(), { cookie: COOKIES, cart: CART });
    await vi.advanceTimersByTimeAsync(1600);
    expect(s.updates()).toEqual([{ attributes: { _fbp: FBP, _fbc: FBC } }]);
    const call = s.calls.find((c) => c.url === "/cart/update.js");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.keepalive).toBe(true);
    expect(call?.init?.headers?.["Content-Type"]).toBe("application/json");
  });

  it("never writes to an empty cart", async () => {
    const s = run(await loadScript(), { cookie: COOKIES, cart: EMPTY });
    await vi.advanceTimersByTimeAsync(1600);
    expect(s.reads()).toBe(1);
    expect(s.updates()).toEqual([]);
  });

  it("does nothing at all without Meta cookies or an fbclid", async () => {
    const s = run(await loadScript(), { cookie: "", cart: CART });
    await vi.advanceTimersByTimeAsync(1600);
    expect(s.calls).toEqual([]);
  });

  it("does not rewrite values already on the cart", async () => {
    const s = run(await loadScript(), { cookie: COOKIES, cart: { item_count: 1, attributes: { _fbp: FBP, _fbc: FBC } } });
    await vi.advanceTimersByTimeAsync(1600);
    expect(s.updates()).toEqual([]);
  });

  it("re-sends the other value too when one changed, keeping an older fbc when no new one exists", async () => {
    const s = run(await loadScript(), { cookie: `_fbp=${FBP}`, cart: { item_count: 1, attributes: { _fbc: FBC } } });
    await vi.advanceTimersByTimeAsync(1600);
    expect(s.updates()).toEqual([{ attributes: { _fbp: FBP, _fbc: FBC } }]);
  });

  it("replaces an older click with a newer one", async () => {
    const s = run(await loadScript(), { cookie: COOKIES, cart: { item_count: 1, attributes: { _fbp: FBP, _fbc: "fb.1.1600000000000.OLDclick" } } });
    await vi.advanceTimersByTimeAsync(1600);
    expect(s.updates()).toEqual([{ attributes: { _fbp: FBP, _fbc: FBC } }]);
  });

  it("builds fbc from the landing URL's fbclid when the cookie is not set yet", async () => {
    const s = run(await loadScript(), { search: "?fbclid=AbC_dEf-123", cart: CART });
    await vi.advanceTimersByTimeAsync(1600);
    expect(s.updates()[0].attributes._fbc).toMatch(/^fb\.1\.\d{13}\.AbC_dEf-123$/);
  });

  it("does not rewrite a rebuilt fbc on reload: same click, new timestamp", async () => {
    const script = await loadScript();
    const s = run(script, { search: "?fbclid=AbC_dEf-123", cart: { item_count: 1, attributes: { _fbc: "fb.1.1600000000000.AbC_dEf-123" } } });
    await vi.advanceTimersByTimeAsync(1600);
    expect(s.updates()).toEqual([]);
  });

  it("does not read again on reload for the same click with a rebuilt fbc", async () => {
    const script = await loadScript();
    const storage = new Map<string, string>();
    const first = run(script, { search: "?fbclid=AbC_dEf-123", cart: EMPTY, storage });
    await vi.advanceTimersByTimeAsync(1600);
    expect(first.reads()).toBe(1);
    const second = run(script, { search: "?fbclid=AbC_dEf-123", cart: EMPTY, storage });
    await vi.advanceTimersByTimeAsync(1600);
    expect(second.reads()).toBe(0);
  });

  it("reads /cart.js at most once per session while the cart stays empty", async () => {
    const script = await loadScript();
    const storage = new Map<string, string>();
    const first = run(script, { cookie: COOKIES, cart: EMPTY, storage });
    await vi.advanceTimersByTimeAsync(1600);
    expect(first.reads()).toBe(1);
    const second = run(script, { cookie: COOKIES, cart: EMPTY, storage });
    await vi.advanceTimersByTimeAsync(1600);
    expect(second.reads()).toBe(0);
  });

  it("survives a failing /cart.js without writing, and looks again on the next page", async () => {
    const script = await loadScript();
    const storage = new Map<string, string>();
    const s = run(script, { cookie: COOKIES, failCart: true, storage });
    await vi.advanceTimersByTimeAsync(1600);
    expect(s.updates()).toEqual([]);
    expect(storage.size).toBe(0);
  });

  it("retries on the next page after a failed update", async () => {
    const script = await loadScript();
    const storage = new Map<string, string>();
    const failed = run(script, { cookie: COOKIES, cart: CART, updateOk: false, storage });
    await vi.advanceTimersByTimeAsync(1600);
    expect(failed.updates()).toHaveLength(1);
    expect(storage.has(CHECK_KEY)).toBe(false);
    const next = run(script, { cookie: COOKIES, cart: CART, storage });
    await vi.advanceTimersByTimeAsync(1600);
    expect(next.updates()).toEqual([{ attributes: { _fbp: FBP, _fbc: FBC } }]);
    expect(storage.has(CHECK_KEY)).toBe(true);
  });

  it("still works where sessionStorage is unavailable", async () => {
    const s = run(await loadScript(), { cookie: COOKIES, cart: CART, noStorage: true });
    await vi.advanceTimersByTimeAsync(1600);
    expect(s.updates()).toEqual([{ attributes: { _fbp: FBP, _fbc: FBC } }]);
  });
});

describe("pixel script: cart attributes after an AJAX add", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("syncs once the add has landed, even though this session already checked", async () => {
    const script = await loadScript();
    const storage = new Map<string, string>();
    const first = run(script, { cookie: COOKIES, cart: EMPTY, storage });
    await vi.advanceTimersByTimeAsync(1600);
    expect(first.updates()).toEqual([]);
    const s = run(script, { cookie: COOKIES, cart: EMPTY, storage });
    await vi.advanceTimersByTimeAsync(1600);
    expect(s.reads()).toBe(0);
    void s.add();
    await vi.advanceTimersByTimeAsync(400);
    expect(s.updates()).toEqual([{ attributes: { _fbp: FBP, _fbc: FBC } }]);
  });

  it("does not lose the sync on an add slower than the fallback timer", async () => {
    const s = run(await loadScript(), { cookie: COOKIES, cart: EMPTY, addDelayMs: 2500 });
    void s.add();
    await vi.advanceTimersByTimeAsync(2100); // the timer fires with the add still in flight: cart reads as empty
    expect(s.updates()).toEqual([]);
    await vi.advanceTimersByTimeAsync(800); // add landed at 2.5 s, sync 300 ms later
    expect(s.state.cart?.attributes).toEqual({ _fbp: FBP, _fbc: FBC });
  });

  it("an empty read that started before an add cannot suppress the next page's check", async () => {
    const script = await loadScript();
    const storage = new Map<string, string>();
    const s = run(script, { cookie: COOKIES, cart: EMPTY, storage, addDelayMs: 10_000, readDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1500); // the page-load read is now in flight
    expect(s.reads()).toBe(1);
    void s.add(); // starts while that read is pending
    await vi.advanceTimersByTimeAsync(1100); // the read comes back empty
    expect(storage.has(CHECK_KEY)).toBe(false);
  });

  it("waits for all the theme's cart writes before its own (warranty add, then main add)", async () => {
    const s = run(await loadScript(), { cookie: COOKIES, cart: CART, addDelayMs: 800 });
    await vi.advanceTimersByTimeAsync(1600); // page-load sync done
    s.state.cart = { item_count: 2, attributes: {} };
    const write = () => s.calls.filter((c) => c.url === "/cart/update.js").length;
    const before = write();
    void s.add(); // warranty
    await vi.advanceTimersByTimeAsync(800); // landed; a second add starts in the same tick
    void s.add();
    await vi.advanceTimersByTimeAsync(500); // past the 300 ms a lone add would wait, second still in flight
    expect(write()).toBe(before);
    await vi.advanceTimersByTimeAsync(700); // second landed + 300 ms
    expect(write()).toBe(before + 1);
  });

  it("does not write while the fallback timer finds an add still in flight on a cart that has items", async () => {
    const s = run(await loadScript(), { cookie: COOKIES, cart: { item_count: 2, attributes: {} }, addDelayMs: 2500 });
    void s.add();
    await vi.advanceTimersByTimeAsync(2100);
    expect(s.updates()).toEqual([]);
    await vi.advanceTimersByTimeAsync(800);
    expect(s.updates()).toEqual([{ attributes: { _fbp: FBP, _fbc: FBC } }]);
  });

  it("recovers from a failed add: no unhandled rejection, and later syncs are not blocked", async () => {
    const s = run(await loadScript(), { cookie: COOKIES, cart: EMPTY, addFails: true });
    await expect(s.add()).rejects.toThrow("network");
    s.state.cart = { item_count: 1, attributes: {} };
    await vi.advanceTimersByTimeAsync(2100); // the fallback timer must not think a write is still running
    expect(s.updates()).toEqual([{ attributes: { _fbp: FBP, _fbc: FBC } }]);
  });

  it("keeps a single timer when an add reschedules it", async () => {
    const s = run(await loadScript(), { cookie: COOKIES, cart: EMPTY });
    void s.add();
    await vi.advanceTimersByTimeAsync(2500);
    // One sync after the add (it also settles the page-load check, and replaced the fallback), plus AddToCart's own SKU lookup.
    expect(s.reads()).toBe(2);
  });

  it("leaves the caller's add promise and its result alone", async () => {
    const s = run(await loadScript(), { cookie: COOKIES, cart: EMPTY });
    const pending = s.add() as Promise<{ ok: boolean }>;
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).ok).toBe(true);
  });
});

describe("pixel script: cart attributes on a form post (buy now)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("adds both values to the form as hidden inputs before it is read", async () => {
    const s = run(await loadScript(), { cookie: COOKIES, cart: EMPTY });
    const inputs = s.submit([{ name: "id", value: "333" }]);
    expect(inputs).toContainEqual(expect.objectContaining({ type: "hidden", name: "attributes[_fbp]", value: FBP }));
    expect(inputs).toContainEqual(expect.objectContaining({ type: "hidden", name: "attributes[_fbc]", value: FBC }));
  });

  it("refreshes its inputs instead of duplicating them on a second click", async () => {
    const s = run(await loadScript(), { cookie: COOKIES, cart: EMPTY });
    const inputs = s.submit([{ name: "id", value: "333" }, { name: "attributes[_fbc]", value: "stale" }]);
    expect(inputs.filter((i) => i.name === "attributes[_fbc]")).toEqual([expect.objectContaining({ value: FBC })]);
  });

  it("adds nothing without Meta cookies", async () => {
    const s = run(await loadScript(), { cookie: "", cart: EMPTY });
    expect(s.submit([{ name: "id", value: "333" }])).toEqual([{ name: "id", value: "333" }]);
  });

  it("forgets the session check, so the page after the post looks at the cart again", async () => {
    const script = await loadScript();
    const storage = new Map<string, string>();
    const s = run(script, { cookie: COOKIES, cart: EMPTY, storage });
    await vi.advanceTimersByTimeAsync(1600);
    expect(storage.has(CHECK_KEY)).toBe(true);
    s.submit([{ name: "id", value: "333" }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(storage.has(CHECK_KEY)).toBe(false);
    const next = run(script, { cookie: COOKIES, cart: CART, storage });
    await vi.advanceTimersByTimeAsync(1600);
    expect(next.updates()).toEqual([{ attributes: { _fbp: FBP, _fbc: FBC } }]);
  });
});
