import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/database", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
vi.mock("@/lib/shopify-client", () => ({ shopifyFetch: vi.fn() }));

const {
  checkFeedLogic, parseGoogleFeed, compareServedFeed, extractSelectedVariantId, runFeedIntegrityAudit,
} = await import("@/lib/feed-integrity-audit");
import type { FeedIntegrityDeps, FeedIntegrityResult } from "@/lib/feed-integrity-audit";
import { shopifyToFeedItems, type ShopifyFeedProduct } from "@/lib/feeds/source";
import { buildGoogleFeed, type FeedItem } from "@/lib/feeds/feed";

const PUBLISHED = "2024-01-01T00:00:00Z";
// Shaped like the live mini fridge: black owns a gallery photo, silver owns an uploaded one,
// red has none (falls back to the hero).
const fridge: ShopifyFeedProduct = {
  id: 100, title: "Mini frigo", handle: "mini-frigo", status: "active", published_at: PUBLISHED,
  images: [{ id: 1, src: "https://cdn/hero.jpg?v=1" }, { id: 2, src: "https://cdn/black.jpg?v=1" }, { id: 9, src: "https://cdn/silver.jpg?v=2" }],
  variants: [
    { id: 1001, sku: "FR-BK", price: "300", inventory_management: null, title: "Noir", image_id: 2 },
    { id: 1002, sku: "FR-SR", price: "300", inventory_management: null, title: "Argent", image_id: 9 },
    { id: 1003, sku: "FR-RD", price: "280", inventory_management: null, title: "Rouge", image_id: null },
  ],
};
const stool: ShopifyFeedProduct = {
  id: 200, title: "Tabouret", handle: "tabouret", status: "active", published_at: PUBLISHED,
  images: [{ id: 20, src: "https://cdn/stool.jpg" }],
  variants: [{ id: 2001, sku: "TB-1", price: "50", inventory_management: null, title: "Default Title" }],
};
const products = [fridge, stool];
const good = () => shopifyToFeedItems(products);

describe("checkFeedLogic", () => {
  it("passes the real mapper output: deep links on multi, bare single, own photos", () => {
    const r = checkFeedLogic(products, good());
    expect(r).toMatchObject({ items: 4, multiItems: 3, singleItems: 1, variantLinks: 3, ownImageItems: 2 });
    expect(Object.values(r.violations).every((n) => n === 0)).toBe(true);
  });

  it("flags every kind of regression, independently of the mapper", () => {
    const items: FeedItem[] = good().map((i) => {
      if (i.id === "FR-BK") return { ...i, link: "https://ameublodirect.ca/products/mini-frigo" };          // lost ?variant=
      if (i.id === "FR-SR") return { ...i, link: `${i.link.split("?")[0]}?variant=1001`, imageLink: "https://cdn/hero.jpg" }; // wrong variant + wrong photo
      if (i.id === "TB-1") return { ...i, link: `${i.link}?variant=2001` };                                   // single got a param
      return i;
    });
    const r = checkFeedLogic(products, items);
    expect(r.violations).toEqual({ missing_variant_link: 1, wrong_variant_link: 1, single_has_variant_link: 1, image_mismatch: 1 });
    expect(r.examples.map((e) => `${e.id}:${e.kind}`)).toEqual([
      "FR-BK:missing_variant_link", "FR-SR:wrong_variant_link", "FR-SR:image_mismatch", "TB-1:single_has_variant_link",
    ]);
  });

  it("ignores the CDN ?v= query when comparing photos", () => {
    const items = good().map((i) => (i.id === "FR-SR" ? { ...i, imageLink: "https://cdn/silver.jpg?v=999" } : i));
    expect(checkFeedLogic(products, items).violations.image_mismatch).toBe(0);
  });
});

describe("parseGoogleFeed / compareServedFeed", () => {
  const xml = buildGoogleFeed(good(), { title: "t", link: "https://x", description: "d" });

  it("reads id, link and image_link back out of the real Google XML", () => {
    const served = parseGoogleFeed(xml);
    expect(served).toHaveLength(4);
    expect(served.find((s) => s.id === "FR-SR")).toEqual({
      id: "FR-SR",
      link: "https://ameublodirect.ca/products/mini-frigo?variant=1002",
      imageLink: "https://cdn/silver.jpg?v=2",
    });
  });

  it("an identical served feed has zero drift", () => {
    expect(compareServedFeed(parseGoogleFeed(xml), good())).toMatchObject({ items: 4, variantLinks: 3, drifted: 0, driftRatio: 0, missing: 0 });
  });

  it("counts items whose link or photo lag behind a fresh generation", () => {
    const stale = parseGoogleFeed(xml).map((s) => (s.id === "FR-SR" ? { ...s, imageLink: "https://cdn/hero.jpg" } : s));
    const r = compareServedFeed(stale, good());
    expect(r.drifted).toBe(1);
    expect(r.driftRatio).toBe(0.25);
  });
});

describe("extractSelectedVariantId", () => {
  it("reads the theme's data-selected-variant JSON", () => {
    const html = `<variant-selects><script type="application/json" data-selected-variant>{"id":47816249016425,"sku":"800-128V81BK"}</script></variant-selects>`;
    expect(extractSelectedVariantId(html)).toBe("47816249016425");
  });
  it("returns null when the marker is absent or not JSON", () => {
    expect(extractSelectedVariantId("<html></html>")).toBeNull();
    expect(extractSelectedVariantId("<script data-selected-variant>oops</script>")).toBeNull();
  });
});

describe("runFeedIntegrityAudit", () => {
  const landingFor = (variantId: string) =>
    `<script type="application/json" data-selected-variant>{"id":${variantId}}</script>`;
  function deps(over: Partial<FeedIntegrityDeps> = {}): FeedIntegrityDeps {
    return {
      fetchProducts: async () => products,
      fetchServedFeed: async () => buildGoogleFeed(good(), { title: "t", link: "https://x", description: "d" }),
      fetchLanding: async (url) => landingFor(/variant=(\d+)/.exec(url)![1]),
      previous: async () => null,
      random: () => 0,
      now: () => 1_790_400_000_000,
      ...over,
    };
  }

  it("healthy feed → ok, no reasons, and every multi-variant landing checked", async () => {
    const r = await runFeedIntegrityAudit(deps());
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.auditedAt).toBe(1_790_400_000);
    expect(r.landing.map((l) => l.outcome)).toEqual(["ok", "ok", "ok"]); // 3 multi-variant offers < sample of 5
  });

  it("tolerates a small served drift (the 24 h cache catching up)", async () => {
    // 1 of 25 items stale = 4 % ≤ 5 %.
    const many: ShopifyFeedProduct[] = Array.from({ length: 25 }, (_, n) => ({
      ...stool, id: 300 + n, handle: `t${n}`, variants: [{ id: 3000 + n, sku: `S-${n}`, price: "10", inventory_management: null }],
    }));
    const fresh = shopifyToFeedItems(many);
    const served = fresh.map((i, n) => (n === 0 ? { ...i, imageLink: "https://cdn/old.jpg" } : i));
    const r = await runFeedIntegrityAudit(deps({
      fetchProducts: async () => many,
      fetchServedFeed: async () => buildGoogleFeed(served, { title: "t", link: "https://x", description: "d" }),
    }));
    expect(r.served!.drifted).toBe(1);
    expect(r.ok).toBe(true);
  });

  it("red: served feed lost every ?variant= link (e.g. a bad deploy)", async () => {
    const bare = good().map((i) => ({ ...i, link: i.link.split("?")[0] }));
    const r = await runFeedIntegrityAudit(deps({ fetchServedFeed: async () => buildGoogleFeed(bare, { title: "t", link: "https://x", description: "d" }) }));
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("le flux Google publié n'a plus aucun lien ?variant=");
  });

  it("red: day-over-day volume drops (items −10 %, ?variant= links −20 %)", async () => {
    const previous = { served: { items: 10, variantLinks: 10 } } as unknown as FeedIntegrityResult;
    const r = await runFeedIntegrityAudit(deps({ previous: async () => previous }));
    expect(r.reasons).toContain("le flux publié a chuté de 10 à 4 offres (60 %) depuis la veille");
    expect(r.reasons).toContain("les liens ?variant= ont chuté de 10 à 3 (70 %) depuis la veille");
    expect(r.volume).toEqual({ previousItems: 10, previousVariantLinks: 10 });
  });

  it("red: the storefront opens another variant, or no longer exposes the selected variant", async () => {
    const wrong = await runFeedIntegrityAudit(deps({ fetchLanding: async () => landingFor("1") }));
    expect(wrong.reasons).toContain("3/3 page(s) produit n'ouvrent pas la variante annoncée");
    const noMarker = await runFeedIntegrityAudit(deps({ fetchLanding: async () => "<html></html>" }));
    expect(noMarker.reasons).toContain("3/3 page(s) produit sans variante présélectionnée lisible (thème modifié ?)");
  });

  it("one unreachable page is noise; a majority unreachable is red", async () => {
    let n = 0;
    const one = await runFeedIntegrityAudit(deps({ fetchLanding: async (u) => (n++ === 0 ? null : landingFor(/variant=(\d+)/.exec(u)![1])) }));
    expect(one.ok).toBe(true);
    const all = await runFeedIntegrityAudit(deps({ fetchLanding: async () => null }));
    expect(all.reasons).toContain("3/3 page(s) produit injoignables");
  });

  it("no false positive when a variant's image_id points at a photo no longer in the gallery", async () => {
    const tampered: ShopifyFeedProduct[] = [{ ...fridge, variants: fridge.variants!.map((v) => (v.sku === "FR-RD" ? { ...v, image_id: 999 } : v)) }, stool];
    const r = await runFeedIntegrityAudit(deps({ fetchProducts: async () => tampered }));
    // image_id 999 is not in the gallery → mapper falls back to the hero, which is also the
    // expected value → no false positive for a stale id.
    expect(r.logic.violations.image_mismatch).toBe(0);
  });

  it("red when the public app URL is unknown (cannot check what Google downloads)", async () => {
    const r = await runFeedIntegrityAudit(deps({ fetchServedFeed: async () => null }));
    expect(r.ok).toBe(false);
    expect(r.served).toBeNull();
    expect(r.reasons).toContain("flux Google publié introuvable (URL publique de l'app inconnue)");
  });
});
