import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import vm from "node:vm";

// The storefront script resolves AddToCart content_ids (SKU) from the PDP meta when the
// variant is on the page, and from /cart.js otherwise (collection quick-add, upsell rail).

async function loadScript(): Promise<string> {
  vi.stubEnv("NEXT_PUBLIC_META_PIXEL_ID", "214720653324969");
  const { GET } = await import("@/app/api/pixel/script/route");
  const res = await GET(new Request("https://aosom-sync.vercel.app/api/pixel/script"));
  return res.text();
}

type FbqCall = unknown[];

function runInFakeStore(script: string, opts: { pdpVariants?: Array<{ id: number; sku: string; price: number }>; cart: unknown }) {
  const fbqCalls: FbqCall[] = [];
  const fetchCalls: string[] = [];
  const nativeFetch = vi.fn((url: string) => {
    fetchCalls.push(url);
    return Promise.resolve({ json: () => Promise.resolve(url === "/cart.js" ? opts.cart : {}) });
  });
  const listeners: Record<string, (ev: unknown) => void> = {};
  const win: Record<string, unknown> = {
    fbq: (...args: unknown[]) => { fbqCalls.push(args); }, // pre-set so the loader stub is skipped
    fetch: nativeFetch,
    ShopifyAnalytics: { meta: opts.pdpVariants ? { page: { pageType: "product" }, product: { type: "Chaise", variants: opts.pdpVariants } } : { page: { pageType: "collection" } } },
    Shopify: { currency: { active: "CAD", rate: "1" } },
    location: { href: "https://ameublodirect.ca/collections/all", search: "" },
    navigator: { sendBeacon: () => true },
    setTimeout,
  };
  win.window = win;
  const document = {
    cookie: "",
    addEventListener: (type: string, fn: (ev: unknown) => void) => { listeners[type] = fn; },
    createElement: () => ({}),
    getElementsByTagName: () => [{ parentNode: { insertBefore: () => {} } }],
  };
  vm.runInNewContext(script, { ...win, window: win, document, JSON, Date, Math, RegExp, String, Promise });
  return { win, fbqCalls, fetchCalls, listeners };
}

const atcCalls = (calls: FbqCall[]) => calls.filter((c) => c[0] === "track" && c[1] === "AddToCart");

describe("pixel script AddToCart content_ids", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("uses the PDP variant SKU immediately when the variant is on the page", async () => {
    const s = runInFakeStore(await loadScript(), { pdpVariants: [{ id: 111, sku: "83A-705V02GN", price: 30999 }], cart: { items: [] } });
    await (s.win.fetch as (u: string, i: unknown) => Promise<unknown>)("/cart/add.js", { body: JSON.stringify({ id: 111, quantity: 1 }) });
    const atc = atcCalls(s.fbqCalls);
    expect(atc).toHaveLength(1);
    expect((atc[0][2] as { content_ids: string[] }).content_ids).toEqual(["83A-705V02GN"]);
    expect(s.fetchCalls).not.toContain("/cart.js");
  });

  it("reads the SKU from /cart.js for a variant not on the page (collection quick-add)", async () => {
    const cart = { currency: "CAD", items: [{ variant_id: 222, sku: "D51-502V00SR", final_price: 18999 }, { variant_id: 111, sku: "OTHER", final_price: 100 }] };
    const s = runInFakeStore(await loadScript(), { cart });
    await (s.win.fetch as (u: string, i: unknown) => Promise<unknown>)("/cart/add.js", { body: JSON.stringify({ id: 222, quantity: 1 }) });
    expect(atcCalls(s.fbqCalls)).toHaveLength(0); // deferred until the add has landed
    await vi.advanceTimersByTimeAsync(1300);
    const atc = atcCalls(s.fbqCalls);
    expect(atc).toHaveLength(1);
    expect(atc[0][2]).toMatchObject({ content_ids: ["D51-502V00SR"], value: 189.99, currency: "CAD" });
  });

  it("still fires AddToCart (without ids) if /cart.js fails", async () => {
    const s = runInFakeStore(await loadScript(), { cart: null });
    await (s.win.fetch as (u: string, i: unknown) => Promise<unknown>)("/cart/add.js", { body: "id=333&quantity=1" });
    await vi.advanceTimersByTimeAsync(1300);
    const atc = atcCalls(s.fbqCalls);
    expect(atc).toHaveLength(1);
    expect((atc[0][2] as { content_ids?: string[] }).content_ids).toBeUndefined();
  });
});
