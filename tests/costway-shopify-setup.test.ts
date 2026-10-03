/**
 * Costway Shopify setup (rabais exclusion, collections, menu) against an in-memory fake store.
 * The fake implements just the endpoints/queries shopify-setup.ts uses, so the real decisions
 * (idempotency, read-back checks, ids preserved across menuUpdate) are what is under test.
 */
import { describe, it, expect } from "vitest";
import {
  ShopifySetupClient,
  withCostwayExclusion,
  COSTWAY_EXCLUSION_RULE,
  COLLECTION_SPECS,
  RABAIS_COLLECTION_GID,
  ELECTRO_COLLECTION_GID,
  planRabais,
  applyRabais,
  planCollections,
  applyCollections,
  registerEnTitle,
  toMenuInput,
  buildMenuUpdate,
  planMenu,
  applyMenu,
  menuCounts,
  linkGid,
  type MenuNode,
  type MenuTree,
  type RuleSet,
  type ShopifyFetchLike,
} from "@/lib/costway/shopify-setup";

interface MenuInputLike { id?: string; title: string; type: string; resourceId?: string; tags?: string[]; items?: MenuInputLike[] }
type Vars = {
  id?: string; q?: string; ids?: string[];
  input?: { ruleSet: RuleSet };
  t?: { value: string }[];
  items?: MenuInputLike[];
};

interface FakeOpts {
  /** Simulate Shopify publishing a collection although published:false was asked. */
  forcePublished?: boolean;
  /** Simulate the old menuUpdate failure: every item recreated with a new id. */
  wipeMenuIds?: boolean;
  /** Simulate the rabais count shifting after the rule change. */
  rabaisCountAfter?: number;
}

function fakeStore(opts: FakeOpts = {}) {
  const calls: { endpoint: string; method: string; query?: string }[] = [];
  let nextId = 900;
  const rabais = {
    id: RABAIS_COLLECTION_GID,
    handle: "rabais-2e-article",
    title: "Rabais 2e article (interne)",
    count: 2055,
    ruleSet: { appliedDisjunctively: false, rules: [{ column: "VARIANT_PRICE", relation: "GREATER_THAN", condition: "0" }] } as RuleSet,
  };
  const collections = new Map<string, { id: string; handle: string; title: string; published_at: string | null }>();
  const translations = new Map<string, string>(); // resourceId -> EN title

  const mk = (id: string, title: string, rid: string | null, items: MenuNode[] = []): MenuNode => ({
    id, title, type: "COLLECTION", url: `/en/collections/${title}`, resourceId: rid, tags: [], items,
  });
  let menu: MenuTree = {
    id: "gid://shopify/Menu/252977709161",
    title: "Catégories",
    handle: "taxonomie-categories",
    items: [
      mk("gid://shopify/MenuItem/1", "Meubles & Déco", "gid://shopify/Collection/10", [
        mk("gid://shopify/MenuItem/2", "Salon", "gid://shopify/Collection/11", [mk("gid://shopify/MenuItem/3", "Tables basses", "gid://shopify/Collection/12")]),
      ]),
      mk("gid://shopify/MenuItem/4", "Électro & Tech", ELECTRO_COLLECTION_GID, [
        mk("gid://shopify/MenuItem/5", "Climatisation & Ventilation", "gid://shopify/Collection/20"),
        mk("gid://shopify/MenuItem/6", "Petit électroménager", "gid://shopify/Collection/21"),
        mk("gid://shopify/MenuItem/7", "Chauffage", "gid://shopify/Collection/22"),
      ]),
    ],
  };
  const flat = (items: MenuNode[]): MenuNode[] => items.flatMap((i) => [i, ...flat(i.items ?? [])]);
  for (const n of flat(menu.items)) translations.set(linkGid(n.id), `EN ${n.title}`);

  const rebuild = (inputs: MenuInputLike[]): MenuNode[] =>
    inputs.map((i) => ({
      id: !opts.wipeMenuIds && i.id ? i.id : `gid://shopify/MenuItem/${++nextId}`,
      title: i.title, type: i.type, url: `/en/collections/${i.title}`, resourceId: i.resourceId ?? null, tags: i.tags ?? [],
      items: rebuild(i.items ?? []),
    }));

  const gql = (query: string, v: Vars): unknown => {
    if (query.includes("collectionUpdate")) {
      rabais.ruleSet = v.input!.ruleSet;
      if (opts.rabaisCountAfter != null) rabais.count = opts.rabaisCountAfter;
      return { collectionUpdate: { userErrors: [] } };
    }
    if (query.includes("collection(id: $id)")) {
      return { collection: v.id === rabais.id ? { ...rabais, productsCount: { count: rabais.count } } : null };
    }
    if (query.includes("collections(first: 5")) {
      const handle = String(v.q).replace("handle:", "");
      const hit = collections.get(handle);
      return { collections: { nodes: hit ? [{ id: hit.id, handle, title: hit.title, productsCount: { count: 0 }, ruleSet: null }] : [] } };
    }
    if (query.includes("translatableResource(resourceId")) return { translatableResource: { translatableContent: [{ key: "title", digest: "d1" }] } };
    if (query.includes("translationsRegister")) {
      translations.set(v.id!, v.t![0].value);
      return { translationsRegister: { userErrors: [] } };
    }
    if (query.includes("translatableResourcesByIds")) {
      return {
        translatableResourcesByIds: {
          nodes: (v.ids as string[]).map((id) => ({ resourceId: id, translations: translations.has(id) ? [{ key: "title", value: translations.get(id) }] : [] })),
        },
      };
    }
    if (query.includes("menuUpdate")) {
      menu = { ...menu, items: rebuild(v.items!) };
      return { menuUpdate: { userErrors: [] } };
    }
    if (query.includes("menu(id: $id)")) return { menu };
    throw new Error("unhandled graphql: " + query.slice(0, 60));
  };

  const fetchFn: ShopifyFetchLike = async (endpoint, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ endpoint, method, query: body?.query });
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (endpoint === "/graphql.json") return ok({ data: gql(body.query, body.variables ?? {}) });
    if (endpoint === "/smart_collections.json" && method === "POST") {
      const sc = body.smart_collection;
      const id = ++nextId;
      const published_at = sc.published || opts.forcePublished ? "2026-10-03T00:00:00Z" : null;
      collections.set(sc.handle, { id: `gid://shopify/Collection/${id}`, handle: sc.handle, title: sc.title, published_at });
      return ok({ smart_collection: { id, handle: sc.handle, published_at } });
    }
    const del = endpoint.match(/^\/smart_collections\/(\d+)\.json$/);
    if (del && method === "DELETE") {
      for (const [h, c] of collections) if (c.id.endsWith(`/${del[1]}`)) collections.delete(h);
      return ok({});
    }
    throw new Error(`unhandled ${method} ${endpoint}`);
  };
  return { client: new ShopifySetupClient(fetchFn), calls, rabais, collections, translations, getMenu: () => menu };
}

describe("withCostwayExclusion", () => {
  const base: RuleSet = { appliedDisjunctively: false, rules: [{ column: "VARIANT_PRICE", relation: "GREATER_THAN", condition: "0" }] };
  it("appends the TAG != src-c rule to the existing AND rules", () => {
    const { ruleSet, changed } = withCostwayExclusion(base);
    expect(changed).toBe(true);
    expect(ruleSet.appliedDisjunctively).toBe(false);
    expect(ruleSet.rules).toEqual([...base.rules, COSTWAY_EXCLUSION_RULE]);
  });
  it("is idempotent: no duplicate on a second pass", () => {
    const once = withCostwayExclusion(base).ruleSet;
    const twice = withCostwayExclusion(once);
    expect(twice.changed).toBe(false);
    expect(twice.ruleSet.rules).toHaveLength(2);
  });
  it("refuses a disjunctive (OR) set, where a != rule would match everything", () => {
    expect(() => withCostwayExclusion({ ...base, appliedDisjunctively: true })).toThrow(/disjunctive/);
  });
});

describe("rabais-2e-article", () => {
  it("applies the rule, keeps the old rule, and verifies the product count did not move", async () => {
    const s = fakeStore();
    const plan = await planRabais(s.client);
    expect(plan.changed).toBe(true);
    const res = await applyRabais(s.client, plan);
    expect(res.count).toBe(2055);
    expect(s.rabais.ruleSet.rules.map((r) => r.column)).toEqual(["VARIANT_PRICE", "TAG"]);
  });
  it("does not write when the rule is already there", async () => {
    const s = fakeStore();
    await applyRabais(s.client, await planRabais(s.client));
    const before = s.calls.length;
    const again = await planRabais(s.client);
    expect(again.changed).toBe(false);
    await applyRabais(s.client, again);
    expect(s.calls.slice(before).some((c) => c.query?.includes("collectionUpdate"))).toBe(false);
  });
  it("fails loudly if the product count changes after the update", async () => {
    const s = fakeStore({ rabaisCountAfter: 10 });
    await expect(applyRabais(s.client, await planRabais(s.client))).rejects.toThrow(/count changed/);
  });
});

describe("collections", () => {
  it("creates the three collections, internal one UNpublished and the others published", async () => {
    const s = fakeStore();
    const created = await applyCollections(s.client, await planCollections(s.client));
    expect(created.map((c) => c.handle).sort()).toEqual(["electro-buanderie", "electro-deshumidificateurs", "suivi-source-c"]);
    expect(created.find((c) => c.handle === "suivi-source-c")!.publishedAt).toBeNull();
    expect(created.find((c) => c.handle === "electro-buanderie")!.publishedAt).not.toBeNull();
  });
  it("sends published:false and the right rules in the REST payload", () => {
    const tracking = COLLECTION_SPECS.find((c) => c.handle === "suivi-source-c")!;
    expect(tracking.published).toBe(false);
    expect(tracking.rules).toEqual([{ column: "tag", relation: "equals", condition: "src-c" }]);
    const laundry = COLLECTION_SPECS.find((c) => c.handle === "electro-buanderie")!;
    expect(laundry.disjunctive).toBe(true);
    expect(laundry.rules.map((r) => r.condition)).toEqual(["Washing Machines", "Clothes Dryers", "Washer Dryer"]);
  });
  it("creates nothing when the handles already exist (idempotent re-run)", async () => {
    const s = fakeStore();
    await applyCollections(s.client, await planCollections(s.client));
    const plan2 = await planCollections(s.client);
    expect(plan2.every((p) => p.exists)).toBe(true);
    const posts = s.calls.length;
    expect(await applyCollections(s.client, plan2)).toEqual([]);
    expect(s.calls.length).toBe(posts);
  });
  it("deletes the tracking collection and fails if Shopify published it anyway", async () => {
    const s = fakeStore({ forcePublished: true });
    await expect(applyCollections(s.client, await planCollections(s.client, COLLECTION_SPECS.filter((c) => !c.published)))).rejects.toThrow(/came back published/);
    expect(s.collections.has("suivi-source-c")).toBe(false);
    expect(s.calls.some((c) => c.method === "DELETE")).toBe(true);
  });
  it("registers an EN title through the digest", async () => {
    const s = fakeStore();
    expect(await registerEnTitle(s.client, "gid://shopify/Collection/5", "Dehumidifiers")).toBe(true);
    expect(s.translations.get("gid://shopify/Collection/5")).toBe("Dehumidifiers");
  });
});

describe("menu", () => {
  const kids = [
    { title: "Déshumidificateurs", resourceId: "gid://shopify/Collection/700", after: "Climatisation & Ventilation" },
    { title: "Buanderie", resourceId: "gid://shopify/Collection/701" },
  ];

  it("re-sends the whole tree with every existing id and adds only the two nodes, in place", async () => {
    const s = fakeStore();
    const menu = s.getMenu();
    const input = buildMenuUpdate(menu, ELECTRO_COLLECTION_GID, kids);
    const electro = input.find((i) => i.resourceId === ELECTRO_COLLECTION_GID)!;
    expect(electro.items!.map((i) => i.title)).toEqual(["Climatisation & Ventilation", "Déshumidificateurs", "Petit électroménager", "Chauffage", "Buanderie"]);
    expect(electro.items!.filter((i) => !i.id).map((i) => i.title)).toEqual(["Déshumidificateurs", "Buanderie"]);
    expect(menuCounts(menu.items)).toEqual([2, 4, 1]);
    const plan = planMenu(menu, ELECTRO_COLLECTION_GID, kids);
    expect(plan.droppedIds).toEqual([]);
    expect(plan.added).toEqual(["Déshumidificateurs", "Buanderie"]);
  });
  it("sends resourceId (not an /en url) for collection items", () => {
    const n: MenuNode = { id: "gid://shopify/MenuItem/9", title: "X", type: "COLLECTION", url: "/en/collections/x", resourceId: "gid://shopify/Collection/1", tags: [] };
    expect(toMenuInput(n)).toEqual({ id: "gid://shopify/MenuItem/9", title: "X", type: "COLLECTION", resourceId: "gid://shopify/Collection/1" });
    expect(toMenuInput({ ...n, resourceId: null, type: "HTTP", url: "/en/pages/a" }).url).toBe("/pages/a");
  });
  it("is idempotent: entries already in the menu are not added again", () => {
    const s = fakeStore();
    const once = planMenu(s.getMenu(), ELECTRO_COLLECTION_GID, kids);
    expect(once.changed).toBe(true);
    const done = { ...s.getMenu(), items: once.input.map(function toNode(i: MenuInputLike): MenuNode { return { id: i.id ?? `gid://shopify/MenuItem/${Math.random()}`, title: i.title, type: i.type, resourceId: i.resourceId, items: (i.items ?? []).map(toNode) }; }) };
    expect(planMenu(done, ELECTRO_COLLECTION_GID, kids).changed).toBe(false);
  });
  it("applyMenu keeps every id and EN translation, and registers EN titles for the new items", async () => {
    const s = fakeStore();
    const plan = planMenu(s.getMenu(), ELECTRO_COLLECTION_GID, kids);
    const res = await applyMenu(s.client, plan, { "Déshumidificateurs": "Dehumidifiers", Buanderie: "Laundry (washers & dryers)" });
    expect(res.before).toEqual([2, 4, 1]);
    expect(res.after).toEqual([2, 6, 1]);
    expect(res.translationsBefore).toEqual({ total: 7, withEn: 7 });
    expect(res.translationsAfter).toEqual({ total: 9, withEn: 9 });
    expect(res.newItems.map((n) => n.enRegistered)).toEqual([true, true]);
  });
  it("detects a menuUpdate that recreates ids (translations orphaned) instead of reporting success", async () => {
    const s = fakeStore({ wipeMenuIds: true });
    const plan = planMenu(s.getMenu(), ELECTRO_COLLECTION_GID, kids);
    await expect(applyMenu(s.client, plan, {})).rejects.toThrow(/LOST \d+ item id/);
  });
  it("refuses a plan that would drop an existing id", async () => {
    const s = fakeStore();
    const plan = planMenu(s.getMenu(), ELECTRO_COLLECTION_GID, kids);
    plan.droppedIds = ["gid://shopify/MenuItem/3"];
    await expect(applyMenu(s.client, plan, {})).rejects.toThrow(/drops existing ids/);
  });
});
