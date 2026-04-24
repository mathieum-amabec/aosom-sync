import type { AosomProduct } from "@/types/aosom";
import type { ProductSnapshot } from "@/lib/database";

export interface ProductDiffResult {
  toInsert: AosomProduct[];
  toUpdate: AosomProduct[];
  unchanged: number;
  removed: string[];
}

export function diffProductsLight(
  csvRows: AosomProduct[],
  snapshot: Map<string, ProductSnapshot>
): ProductDiffResult {
  const toInsert: AosomProduct[] = [];
  const toUpdate: AosomProduct[] = [];
  let unchanged = 0;
  const seenSkus = new Set<string>();

  for (const row of csvRows) {
    seenSkus.add(row.sku);
    const snap = snapshot.get(row.sku);

    if (!snap) {
      toInsert.push(row);
      continue;
    }

    if (hasChanged(row, snap)) {
      toUpdate.push(row);
    } else {
      unchanged++;
    }
  }

  const removed = [...snapshot.keys()].filter(sku => !seenSkus.has(sku));

  return { toInsert, toUpdate, unchanged, removed };
}

function hasChanged(row: AosomProduct, snap: ProductSnapshot): boolean {
  if (row.price !== snap.price) return true;
  if (row.qty !== snap.qty) return true;
  if (row.outOfStockExpected !== snap.out_of_stock_expected) return true;
  if (row.estimatedArrival !== snap.estimated_arrival) return true;
  if (row.name !== snap.name) return true;
  if (row.color !== snap.color) return true;
  if (row.size !== snap.size) return true;
  if (row.productType !== snap.product_type) return true;
  if (row.video !== snap.video) return true;
  if (row.description !== snap.description) return true;
  if (row.shortDescription !== snap.short_description) return true;
  if (row.material !== snap.material) return true;
  if (row.gtin !== snap.gtin) return true;
  if (row.weight !== snap.weight) return true;

  const imgs = row.images;
  if ((imgs[0] ?? "") !== snap.image1) return true;
  if ((imgs[1] ?? "") !== snap.image2) return true;
  if ((imgs[2] ?? "") !== snap.image3) return true;
  if ((imgs[3] ?? "") !== snap.image4) return true;
  if ((imgs[4] ?? "") !== snap.image5) return true;
  if ((imgs[5] ?? "") !== snap.image6) return true;
  if ((imgs[6] ?? "") !== snap.image7) return true;

  return false;
}
