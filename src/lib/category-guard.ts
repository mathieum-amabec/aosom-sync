/**
 * Daily category guardrail (2026-10-02, Mat: "s'assurer que les nouveaux items ajoutés se
 * retrouvent dans la bonne catégorie").
 *
 * What the audit that day found, and what this keeps watching:
 *   1. SHOPPER REACH — every active product must sit in at least one collection linked from
 *      the storefront menus (the mega-menu `taxonomie-categories`, `main-menu`). The menu
 *      collections are mostly SMART (rule = product_type contains …), so a product Aosom files
 *      under a renamed branch silently falls out: on 2026-10-02 "Salle de bain" missed 23
 *      bathroom cabinets because Aosom moved them from "Bedding & Bath" to "Bathroom Furniture".
 *   2. IMPORT MAPPINGS — `collection_mappings` rows pointing at a deleted collection (the import
 *      then fails to assign; "Autres" had been deleted with 27 products still mapped to it).
 *
 * Limit: a product reachable through a PARENT section but missing from its own sub-section
 * (the bathroom cabinets were still under "Meubles & Déco") is not flagged — no rule can know
 * every family. Re-check sub-section rules when Aosom renames a branch.
 *
 * Read-only: it reports (dashboard notification), it never moves products.
 */
import { shopifyFetch } from "@/lib/shopify-client";
import { getAllCollectionMappings, createNotification } from "@/lib/database";

const MENU_HANDLES = ["taxonomie-categories", "main-menu"];

export interface CategoryGuardReport {
  activeProducts: number;
  menuCollections: number;
  /** Active products in no menu-linked collection. */
  unreachable: Array<{ handle: string; productType: string }>;
  /** collection_mappings rows whose Shopify collection no longer exists. */
  staleMappings: Array<{ aosomCategory: string; role: string; title: string }>;
  notified: boolean;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  await new Promise((r) => setTimeout(r, 400)); // ≤ 2 req/s
  const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors || !json.data) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
  return json.data;
}

type MenuItem = { resourceId?: string | null; items?: MenuItem[] };

/** Collection ids (numeric strings) linked anywhere in the given menus. Exported for tests. */
export function collectMenuCollectionIds(menus: Array<{ handle: string; items: MenuItem[] }>, handles = MENU_HANDLES): Set<string> {
  const ids = new Set<string>();
  const walk = (items: MenuItem[] | undefined) => {
    for (const it of items ?? []) {
      if (it.resourceId?.includes("/Collection/")) ids.add(it.resourceId.split("/").pop()!);
      walk(it.items);
    }
  };
  for (const m of menus) if (handles.includes(m.handle)) walk(m.items);
  return ids;
}

export async function runCategoryGuard(opts: { notify?: boolean } = {}): Promise<CategoryGuardReport> {
  const menus = (
    await gql<{ menus: { nodes: Array<{ handle: string; items: MenuItem[] }> } }>(
      `{ menus(first: 20) { nodes { handle items { resourceId items { resourceId items { resourceId } } } } } }`,
    )
  ).menus.nodes;
  const menuIds = collectMenuCollectionIds(menus);

  const unreachable: CategoryGuardReport["unreachable"] = [];
  let active = 0;
  let cursor: string | null = null;
  do {
    const d: {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ handle: string; productType: string; collections: { nodes: Array<{ legacyResourceId: string }> } }>;
      };
    } = await gql(
      `query($c: String) { products(first: 100, after: $c, query: "status:active") {
         pageInfo { hasNextPage endCursor }
         nodes { handle productType collections(first: 40) { nodes { legacyResourceId } } } } }`,
      { c: cursor },
    );
    for (const p of d.products.nodes) {
      active++;
      if (!p.collections.nodes.some((c) => menuIds.has(String(c.legacyResourceId)))) {
        unreachable.push({ handle: p.handle, productType: p.productType });
      }
    }
    cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (cursor);

  const staleMappings: CategoryGuardReport["staleMappings"] = [];
  for (const m of await getAllCollectionMappings()) {
    const id = String(m.shopifyCollectionId).replace(/\D/g, "");
    const c = await gql<{ collection: { id: string } | null }>(`query($id: ID!) { collection(id: $id) { id } }`, {
      id: `gid://shopify/Collection/${id}`,
    });
    if (!c.collection) staleMappings.push({ aosomCategory: m.aosomCategory, role: m.collectionRole ?? "sub", title: m.shopifyCollectionTitle });
  }

  let notified = false;
  if (opts.notify !== false && (unreachable.length > 0 || staleMappings.length > 0)) {
    const lines: string[] = [];
    if (unreachable.length) {
      const byType = new Map<string, number>();
      for (const u of unreachable) byType.set(u.productType || "(sans type)", (byType.get(u.productType || "(sans type)") ?? 0) + 1);
      lines.push(
        `${unreachable.length} produit(s) actif(s) dans aucune catégorie du menu — ` +
          [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => `${n}× ${t}`).join(" ; "),
      );
    }
    if (staleMappings.length) {
      lines.push(
        `${staleMappings.length} correspondance(s) d'import vers une collection supprimée : ` +
          staleMappings.slice(0, 6).map((s) => `${s.aosomCategory} → « ${s.title} »`).join(" ; "),
      );
    }
    await createNotification("warning", "Catégories à vérifier", lines.join("\n"));
    notified = true;
  }
  return { activeProducts: active, menuCollections: menuIds.size, unreachable, staleMappings, notified };
}
