import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/shopify-client", () => ({ shopifyFetch: vi.fn() }));
vi.mock("@/lib/database", () => ({ getAllCollectionMappings: vi.fn(), createNotification: vi.fn() }));

import { collectMenuCollectionIds } from "@/lib/category-guard";

describe("collectMenuCollectionIds", () => {
  it("collects collection ids at every depth of the storefront menus only", () => {
    const menus = [
      { handle: "taxonomie-categories", items: [
        { resourceId: "gid://shopify/Collection/1", items: [{ resourceId: "gid://shopify/Collection/2", items: [{ resourceId: "gid://shopify/Collection/3" }] }] },
        { resourceId: "gid://shopify/Page/9" },
      ] },
      { handle: "main-menu", items: [{ resourceId: "gid://shopify/Collection/4" }] },
      { handle: "preview-main-menu", items: [{ resourceId: "gid://shopify/Collection/99" }] },
    ];
    expect([...collectMenuCollectionIds(menus)].sort()).toEqual(["1", "2", "3", "4"]);
  });
});
