/**
 * Sub-category tree for the social "Ciblage précis" picker (2026-10-02).
 *
 * Aggregates in-stock products by Aosom `product_type` branch, counting distinct Shopify
 * FICHES (a fiche's colour variants are several SKUs but one post), and how many of those
 * can actually be posted right now: lifestyle-verified AND outside the repost window.
 * That last number is the one the operator needs — on 2026-10-02 "Car Shelters" had 9
 * fiches and 0 postable, which no amount of filtering fixes.
 *
 * Every node counts its whole subtree, matching buildTargetCategory, where a branch
 * selects itself and every sub-branch.
 */

export interface TargetRow {
  productType: string;
  shopifyProductId: string;
  lastPostedAt: number | null;
}

export interface TargetNode {
  /** Full product_type branch, e.g. "Patio & Garden > Fire Pits". */
  path: string;
  /** Last segment, for display. */
  name: string;
  /** 0 = top level. */
  depth: number;
  /** Distinct in-stock fiches in this subtree. */
  fiches: number;
  /** Of those, lifestyle-verified (null when Shopify could not say). */
  verified: number | null;
  /** Verified AND no post within the cooldown — what a click can produce right now. */
  postable: number | null;
}

/**
 * @param verifiedIds lifestyle-verified Shopify product ids, or null when unknown
 * @param cutoff      epoch seconds; a fiche posted at or after this is in its cooldown
 */
export function buildTargetTree(
  rows: TargetRow[],
  verifiedIds: Set<string> | null,
  cutoff: number,
): TargetNode[] {
  // A fiche is free when NONE of its SKUs was posted recently (markProductPosted stamps
  // them all together, so in practice they agree).
  const recentlyPosted = new Set(
    rows.filter((r) => r.lastPostedAt != null && r.lastPostedAt >= cutoff).map((r) => r.shopifyProductId),
  );
  const byPath = new Map<string, Set<string>>();
  for (const r of rows) {
    const segs = r.productType.split(" > ").map((s) => s.trim()).filter(Boolean);
    for (let i = 1; i <= segs.length; i++) {
      const path = segs.slice(0, i).join(" > ");
      let set = byPath.get(path);
      if (!set) byPath.set(path, (set = new Set()));
      set.add(r.shopifyProductId);
    }
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, ids]) => {
      const segs = path.split(" > ");
      const fiches = [...ids];
      const verified = verifiedIds ? fiches.filter((id) => verifiedIds.has(id)) : null;
      return {
        path,
        name: segs[segs.length - 1],
        depth: segs.length - 1,
        fiches: fiches.length,
        verified: verified ? verified.length : null,
        postable: verified ? verified.filter((id) => !recentlyPosted.has(id)).length : null,
      };
    });
}
