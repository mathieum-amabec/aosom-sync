/**
 * One-off Shopify store setup the Costway pilot import needs BEFORE any Costway product exists.
 * Pure builders + a thin layer over an injected `ShopifyFetchLike`, so every decision is unit-tested
 * against a fake store and the CLI (scripts/costway-setup-shopify.mts) only wires real I/O.
 *
 *  a) `rabais-2e-article` must exclude Costway. It is the collection the automatic BXGY
 *     "10% sur le 2e article" buys from AND gets from, and its only rule is `variant price > 0`, so
 *     EVERY product joins it. With a 16% dropship discount a 10% second-item rebate leaves ~6%
 *     (and can sink under Costway's `Price Drop` floor) — Costway products carry the tag `src-c`
 *     and are excluded with a ANDed `TAG != src-c` rule.
 *  b) Three smart collections: two shopper-facing categories (Déshumidificateurs, Buanderie) and an
 *     INTERNAL tracking collection (tag = src-c) that must never be published to the storefront.
 *  c) Menu step (explicit flag only): the two category collections under « Électro & Tech », via
 *     menuUpdate re-sending the whole tree WITH item ids so the 92 EN translations survive.
 *
 * Scopes (checked 2026-10-03): products, online-store navigation, translations are granted;
 * `read/write_publications` is NOT — so `publishableUnpublish` is unavailable. Publication state is
 * therefore controlled only through the legacy REST `published` flag at creation time, and verified
 * afterwards by reading `published_at` back.
 */

/** Product tag carried by every Costway product — neutral, public tags can't reveal the supplier. */
export const COSTWAY_TAG = "src-c";

export const RABAIS_COLLECTION_GID = "gid://shopify/Collection/485596921961";
export const ELECTRO_COLLECTION_GID = "gid://shopify/Collection/475646394473";
export const TAXONOMY_MENU_GID = "gid://shopify/Menu/252977709161";

// ── Injected I/O ───────────────────────────────────────────────────────────────────────────

/** The slice of `Response` the setup code uses. */
export interface ShopifyResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
/** `endpoint` is relative to `/admin/api/<version>` (e.g. "/graphql.json", "/smart_collections.json"). */
export type ShopifyFetchLike = (
  endpoint: string,
  init?: { method?: string; body?: string },
) => Promise<ShopifyResponseLike>;

export class ShopifySetupClient {
  constructor(private readonly fetchFn: ShopifyFetchLike) {}

  async gql<T = Record<string, unknown>>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchFn("/graphql.json", { method: "POST", body: JSON.stringify({ query, variables }) });
    if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: T; errors?: unknown };
    if (body.errors || !body.data) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(body.errors ?? "no data").slice(0, 300)}`);
    return body.data;
  }

  async rest<T = Record<string, unknown>>(endpoint: string, method = "GET", payload?: unknown): Promise<T> {
    const res = await this.fetchFn(endpoint, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    if (!res.ok) throw new Error(`Shopify REST ${method} ${endpoint} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return method === "DELETE" ? ({} as T) : ((await res.json()) as T);
  }
}

// ── Collection rules ───────────────────────────────────────────────────────────────────────

export interface CollectionRule {
  column: string;
  relation: string;
  condition: string;
}
export interface RuleSet {
  appliedDisjunctively: boolean;
  rules: CollectionRule[];
}

const ruleKey = (r: CollectionRule) => `${r.column}|${r.relation}|${r.condition}`;
const RULE_FIELDS = `ruleSet { appliedDisjunctively rules { column relation condition } }`;

/** The exclusion rule that keeps Costway out of the 2nd-item rebate. */
export const COSTWAY_EXCLUSION_RULE: CollectionRule = { column: "TAG", relation: "NOT_EQUALS", condition: COSTWAY_TAG };

/**
 * `existing` + the exclusion rule. Idempotent (never duplicates). The set must stay CONJUNCTIVE:
 * with `appliedDisjunctively = true` a `!= src-c` rule would be OR-ed in and match every product.
 */
export function withCostwayExclusion(existing: RuleSet): { ruleSet: RuleSet; changed: boolean } {
  if (existing.appliedDisjunctively) {
    throw new Error("rabais-2e-article is disjunctive (OR): adding a NOT_EQUALS rule would match every product — refusing");
  }
  const has = existing.rules.some((r) => ruleKey(r) === ruleKey(COSTWAY_EXCLUSION_RULE));
  return {
    ruleSet: { appliedDisjunctively: false, rules: has ? existing.rules : [...existing.rules, COSTWAY_EXCLUSION_RULE] },
    changed: !has,
  };
}

export interface RabaisPlan {
  id: string;
  title: string;
  handle: string;
  count: number;
  current: RuleSet;
  desired: RuleSet;
  changed: boolean;
}

interface CollectionNode {
  id: string;
  handle: string;
  title: string;
  productsCount: { count: number };
  ruleSet: RuleSet | null;
}

export async function planRabais(client: ShopifySetupClient): Promise<RabaisPlan> {
  const data = await client.gql<{ collection: CollectionNode | null }>(
    `query($id: ID!) { collection(id: $id) { id handle title productsCount { count } ${RULE_FIELDS} } }`,
    { id: RABAIS_COLLECTION_GID },
  );
  const c = data.collection;
  if (!c || !c.ruleSet) throw new Error("rabais-2e-article not found or not a smart collection");
  const { ruleSet, changed } = withCostwayExclusion(c.ruleSet);
  return { id: c.id, title: c.title, handle: c.handle, count: c.productsCount.count, current: c.ruleSet, desired: ruleSet, changed };
}

/** Applies the rule, then reads back: rules present, existing rules kept, product count unchanged. */
export async function applyRabais(client: ShopifySetupClient, plan: RabaisPlan): Promise<{ count: number }> {
  if (!plan.changed) return { count: plan.count };
  const out = await client.gql<{ collectionUpdate: { userErrors: { message: string }[] } }>(
    `mutation($input: CollectionInput!) { collectionUpdate(input: $input) { userErrors { field message } } }`,
    { input: { id: plan.id, ruleSet: plan.desired } },
  );
  if (out.collectionUpdate.userErrors.length) {
    throw new Error(`collectionUpdate rabais: ${out.collectionUpdate.userErrors.map((e) => e.message).join("; ")}`);
  }
  const after = await planRabais(client);
  const keys = new Set(after.current.rules.map(ruleKey));
  if (!keys.has(ruleKey(COSTWAY_EXCLUSION_RULE))) throw new Error("rabais read-back: exclusion rule missing");
  for (const r of plan.current.rules) if (!keys.has(ruleKey(r))) throw new Error(`rabais read-back: lost existing rule ${ruleKey(r)}`);
  if (after.current.appliedDisjunctively) throw new Error("rabais read-back: collection became disjunctive");
  if (after.count !== plan.count) {
    throw new Error(`rabais read-back: product count changed ${plan.count} → ${after.count} (no Costway product exists yet, so it must not)`);
  }
  return { count: after.count };
}

// ── Collections to create ──────────────────────────────────────────────────────────────────

export interface CollectionSpec {
  title: string;
  handle: string;
  enTitle: string;
  rules: { column: "type" | "tag"; relation: "contains" | "equals"; condition: string }[];
  disjunctive: boolean;
  /** false = must NOT appear on the Online Store. */
  published: boolean;
  /** What this collection is for — printed in the plan. */
  note: string;
}

export const COLLECTION_SPECS: CollectionSpec[] = [
  {
    title: "Déshumidificateurs",
    handle: "electro-deshumidificateurs",
    enTitle: "Dehumidifiers",
    rules: [{ column: "type", relation: "contains", condition: "Dehumidifiers" }],
    disjunctive: false,
    published: true,
    note:
      'product_type "Home Furnishings > Appliances > Dehumidifiers". Those products ALSO land in « Climatisation & Ventilation » ' +
      '(rule: type contains "Dehumidifier") and « Électro & Tech » (rule: type contains "Home Furnishings > Appliances") — desired.',
  },
  {
    title: "Buanderie",
    handle: "electro-buanderie",
    enTitle: "Laundry (washers & dryers)",
    rules: [
      { column: "type", relation: "contains", condition: "Washing Machines" },
      { column: "type", relation: "contains", condition: "Clothes Dryers" },
      { column: "type", relation: "contains", condition: "Washer Dryer" },
    ],
    disjunctive: true,
    published: true,
    note: 'product_types "…> Appliances > Washing Machines / Clothes Dryers / Washer Dryer Combos"; also in « Électro & Tech ».',
  },
  {
    title: "Suivi — source C (interne)",
    handle: "suivi-source-c",
    enTitle: "Tracking — source C (internal)",
    rules: [{ column: "tag", relation: "equals", condition: COSTWAY_TAG }],
    disjunctive: false,
    published: false,
    note: "INTERNAL follow-up list of every Costway product (tag src-c) for the Shopify admin. Never published to the Online Store.",
  },
];

export interface CollectionPlanItem {
  spec: CollectionSpec;
  exists: boolean;
  existing?: { id: string; title: string; count: number };
}

export async function planCollections(client: ShopifySetupClient, specs = COLLECTION_SPECS): Promise<CollectionPlanItem[]> {
  const out: CollectionPlanItem[] = [];
  for (const spec of specs) {
    const data = await client.gql<{ collections: { nodes: CollectionNode[] } }>(
      `query($q: String!) { collections(first: 5, query: $q) { nodes { id handle title productsCount { count } ${RULE_FIELDS} } } }`,
      { q: `handle:${spec.handle}` },
    );
    const hit = data.collections.nodes.find((n) => n.handle === spec.handle);
    out.push({
      spec,
      exists: !!hit,
      existing: hit ? { id: hit.id, title: hit.title, count: hit.productsCount.count } : undefined,
    });
  }
  return out;
}

export interface CreatedCollection {
  handle: string;
  id: string;
  gid: string;
  publishedAt: string | null;
}

/**
 * Creates the collections that don't exist yet (REST, so `published` can be set at creation — the
 * granted scopes have no publications API). The tracking collection's `published_at` is read back:
 * if the store published it anyway it is deleted at once (it is empty and was created seconds ago)
 * and the run fails loudly rather than leaving an internal page on the storefront.
 */
export async function applyCollections(client: ShopifySetupClient, plan: CollectionPlanItem[]): Promise<CreatedCollection[]> {
  const created: CreatedCollection[] = [];
  for (const item of plan) {
    if (item.exists) continue;
    const { spec } = item;
    const res = await client.rest<{ smart_collection: { id: number; handle: string; published_at: string | null } }>(
      "/smart_collections.json",
      "POST",
      {
        smart_collection: {
          title: spec.title,
          handle: spec.handle,
          rules: spec.rules,
          disjunctive: spec.disjunctive,
          published: spec.published,
        },
      },
    );
    const sc = res.smart_collection;
    created.push({ handle: sc.handle, id: String(sc.id), gid: `gid://shopify/Collection/${sc.id}`, publishedAt: sc.published_at ?? null });
    if (!spec.published && sc.published_at) {
      await client.rest(`/smart_collections/${sc.id}.json`, "DELETE");
      throw new Error(
        `"${spec.handle}" came back published (${sc.published_at}) although published:false was requested — deleted it again. ` +
          `Unpublishing needs the publications scope, which this app lacks: create it by hand in the admin (Online Store unchecked).`,
      );
    }
    if (spec.published && !sc.published_at) {
      throw new Error(`"${spec.handle}" was created UNpublished although published:true was requested — publish it in the admin.`);
    }
  }
  return created;
}

// ── EN translations ────────────────────────────────────────────────────────────────────────

/** Registers `value` as the EN `title` of a translatable resource. Returns false if there is nothing to register. */
export async function registerEnTitle(client: ShopifySetupClient, resourceId: string, value: string): Promise<boolean> {
  const data = await client.gql<{ translatableResource: { translatableContent: { key: string; digest: string }[] } | null }>(
    `query($id: ID!) { translatableResource(resourceId: $id) { translatableContent { key digest } } }`,
    { id: resourceId },
  );
  const digest = data.translatableResource?.translatableContent.find((c) => c.key === "title")?.digest;
  if (!digest) return false;
  const out = await client.gql<{ translationsRegister: { userErrors: { message: string }[] } }>(
    `mutation($id: ID!, $t: [TranslationInput!]!) { translationsRegister(resourceId: $id, translations: $t) { userErrors { field message } } }`,
    { id: resourceId, t: [{ key: "title", locale: "en", value, translatableContentDigest: digest }] },
  );
  if (out.translationsRegister.userErrors.length) {
    throw new Error(`translationsRegister ${resourceId}: ${out.translationsRegister.userErrors.map((e) => e.message).join("; ")}`);
  }
  return true;
}

// ── Menu ───────────────────────────────────────────────────────────────────────────────────

export interface MenuNode {
  id: string;
  title: string;
  type: string;
  url?: string | null;
  resourceId?: string | null;
  tags?: string[] | null;
  items?: MenuNode[];
}
export interface MenuTree {
  id: string;
  title: string;
  handle: string;
  items: MenuNode[];
}
export interface MenuItemInput {
  id?: string;
  title: string;
  type: string;
  resourceId?: string;
  url?: string;
  tags?: string[];
  items?: MenuItemInput[];
}

const MENU_QUERY = `query($id: ID!) { menu(id: $id) { id title handle items { id title type url resourceId tags items { id title type url resourceId tags items { id title type url resourceId tags } } } } }`;

export async function fetchMenu(client: ShopifySetupClient, id = TAXONOMY_MENU_GID): Promise<MenuTree> {
  const data = await client.gql<{ menu: MenuTree | null }>(MENU_QUERY, { id });
  if (!data.menu) throw new Error(`menu ${id} not found`);
  return data.menu;
}

/** `/en/collections/x` → `/collections/x` — the API echoes an /en prefix that it then rejects on resubmit. */
const stripLocale = (u: string) => u.replace(/^\/en(?=\/|$)/, "") || "/";

/**
 * Existing node → input. The `id` is what keeps the item (and its EN translation) alive across
 * menuUpdate; COLLECTION/PAGE items send `resourceId` (Shopify derives and localises the url), other
 * types fall back to a locale-stripped url.
 */
export function toMenuInput(n: MenuNode): MenuItemInput {
  const out: MenuItemInput = { id: n.id, title: n.title, type: n.type };
  if (n.resourceId) out.resourceId = n.resourceId;
  else if (n.url) out.url = stripLocale(n.url);
  if (n.tags && n.tags.length) out.tags = n.tags;
  if (n.items && n.items.length) out.items = n.items.map(toMenuInput);
  return out;
}

export interface NewMenuChild {
  title: string;
  /** Collection gid. */
  resourceId: string;
  /** Insert right after the sibling with this title; omit to append at the end. */
  after?: string;
}

/** Whole tree to send, with `children` spliced under the L1 item whose resourceId is `parentResourceId`. */
export function buildMenuUpdate(menu: MenuTree, parentResourceId: string, children: NewMenuChild[]): MenuItemInput[] {
  const tree = menu.items.map(toMenuInput);
  const parent = tree.find((i) => i.resourceId === parentResourceId);
  if (!parent) throw new Error(`menu has no top-level item for ${parentResourceId}`);
  const kids = parent.items ?? [];
  for (const c of children) {
    if (kids.some((k) => k.resourceId === c.resourceId || k.title === c.title)) continue; // idempotent
    const node: MenuItemInput = { title: c.title, type: "COLLECTION", resourceId: c.resourceId };
    const at = c.after ? kids.findIndex((k) => k.title === c.after) : -1;
    if (at >= 0) kids.splice(at + 1, 0, node);
    else kids.push(node);
  }
  parent.items = kids;
  return tree;
}

const flatten = (items: { id?: string; items?: { id?: string; items?: unknown[] }[] }[] | undefined, depth = 1, acc: { depth: number; node: { id?: string } }[] = []) => {
  for (const it of items ?? []) {
    acc.push({ depth, node: it });
    flatten(it.items as never, depth + 1, acc);
  }
  return acc;
};

export const menuCounts = (items: { items?: unknown[] }[]) => {
  const flat = flatten(items as never);
  return [1, 2, 3].map((d) => flat.filter((f) => f.depth === d).length) as [number, number, number];
};

export interface MenuPlan {
  menu: MenuTree;
  input: MenuItemInput[];
  before: [number, number, number];
  after: [number, number, number];
  added: string[];
  /** Existing item ids that the planned tree no longer carries — must be empty. */
  droppedIds: string[];
  changed: boolean;
}

export function planMenu(menu: MenuTree, parentResourceId: string, children: NewMenuChild[]): MenuPlan {
  const input = buildMenuUpdate(menu, parentResourceId, children);
  const oldIds = flatten(menu.items as never).map((f) => f.node.id as string);
  const keptIds = new Set(flatten(input as never).map((f) => f.node.id).filter(Boolean));
  const droppedIds = oldIds.filter((id) => !keptIds.has(id));
  const before = menuCounts(menu.items);
  const after = menuCounts(input as never);
  const added = flatten(input as never)
    .filter((f) => !(f.node as { id?: string }).id)
    .map((f) => (f.node as unknown as MenuItemInput).title);
  return { menu, input, before, after, added, droppedIds, changed: added.length > 0 };
}

const numericId = (gid: string) => gid.split("/").pop() as string;
export const linkGid = (menuItemGid: string) => `gid://shopify/Link/${numericId(menuItemGid)}`;

/** How many of the menu's items already carry an EN title — the number that must not drop. */
export async function countMenuEnTranslations(client: ShopifySetupClient, menu: MenuTree): Promise<{ total: number; withEn: number }> {
  const ids = flatten(menu.items as never).map((f) => linkGid(f.node.id as string));
  let total = 0;
  let withEn = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const data = await client.gql<{ translatableResourcesByIds: { nodes: { translations: { key: string; value: string }[] }[] } }>(
      `query($ids: [ID!]!) { translatableResourcesByIds(first: 100, resourceIds: $ids) { nodes { resourceId translations(locale: "en") { key value } } } }`,
      { ids: ids.slice(i, i + 100) },
    );
    for (const n of data.translatableResourcesByIds.nodes) {
      total++;
      if (n.translations.some((t) => t.key === "title" && t.value)) withEn++;
    }
  }
  return { total, withEn };
}

export interface MenuApplyResult {
  before: [number, number, number];
  after: [number, number, number];
  translationsBefore: { total: number; withEn: number };
  translationsAfter: { total: number; withEn: number };
  newItems: { title: string; id: string; enRegistered: boolean }[];
}

/**
 * menuUpdate with the whole tree + ids, then proves nothing was lost: every old id still present,
 * counts = old + added, EN translation coverage not reduced; finally registers the EN title of the
 * new items on their Link resource.
 */
export async function applyMenu(
  client: ShopifySetupClient,
  plan: MenuPlan,
  enTitles: Record<string, string>,
): Promise<MenuApplyResult> {
  if (plan.droppedIds.length) throw new Error(`refusing: planned tree drops existing ids ${plan.droppedIds.join(", ")}`);
  if (!plan.changed) throw new Error("nothing to add to the menu");
  const translationsBefore = await countMenuEnTranslations(client, plan.menu);

  const out = await client.gql<{ menuUpdate: { userErrors: { message: string }[] } }>(
    `mutation($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
       menuUpdate(id: $id, title: $title, handle: $handle, items: $items) { userErrors { field message } }
     }`,
    { id: plan.menu.id, title: plan.menu.title, handle: plan.menu.handle, items: plan.input },
  );
  if (out.menuUpdate.userErrors.length) throw new Error(`menuUpdate: ${out.menuUpdate.userErrors.map((e) => e.message).join("; ")}`);

  const after = await fetchMenu(client, plan.menu.id);
  const oldIds = flatten(plan.menu.items as never).map((f) => f.node.id as string);
  const newIds = new Set(flatten(after.items as never).map((f) => f.node.id as string));
  const lost = oldIds.filter((id) => !newIds.has(id));
  if (lost.length) {
    throw new Error(
      `menuUpdate LOST ${lost.length} item id(s) (${lost.slice(0, 5).join(", ")}…) — their EN translations are orphaned; ` +
        `re-register them (see memory menuupdate-destroys-translations).`,
    );
  }
  const counts = menuCounts(after.items);
  if (counts.join() !== plan.after.join()) throw new Error(`menu counts ${counts.join("/")} ≠ planned ${plan.after.join("/")}`);

  const oldSet = new Set(oldIds);
  const created = flatten(after.items as never)
    .map((f) => f.node as unknown as MenuNode)
    .filter((n) => !oldSet.has(n.id));
  const newItems: MenuApplyResult["newItems"] = [];
  for (const n of created) {
    const en = enTitles[n.title];
    const enRegistered = en ? await registerEnTitle(client, linkGid(n.id), en) : false;
    newItems.push({ title: n.title, id: n.id, enRegistered });
  }

  const translationsAfter = await countMenuEnTranslations(client, after);
  const expectedWithEn = translationsBefore.withEn + newItems.filter((i) => i.enRegistered).length;
  if (translationsAfter.withEn < expectedWithEn) {
    throw new Error(`EN menu translations dropped: ${translationsBefore.withEn} → ${translationsAfter.withEn} (expected ≥ ${expectedWithEn})`);
  }
  return { before: plan.before, after: counts, translationsBefore, translationsAfter, newItems };
}
