/**
 * Seasonal — maps a season/event theme to a set of product_types, pulls each via
 * byCategory, then merges + dedupes (by SKU) into one COUNTDOWN-ready set.
 *
 * Themes use the catalogue's English product_type values (Quebec store, EN
 * taxonomy). Unknown themes resolve to no categories → [].
 */
import { byCategory } from "./by-category";
import type { ProductItem, SelectorOptions } from "./types";

/** theme → catalogue product_types. */
export const SEASONAL_THEMES: Record<string, string[]> = {
  "fete-peres": ["Outdoor Furniture", "BBQ", "Tools"],
  bbq: ["BBQ", "Outdoor Dining", "Patio"],
  rentree: ["Office Furniture", "Storage", "Kids"],
  ete: ["Patio", "Garden", "Pool", "Outdoor"],
  hiver: ["Indoor Furniture", "Heating", "Christmas"],
};

export async function seasonal(theme: string, opts: SelectorOptions = {}): Promise<ProductItem[]> {
  const categories = SEASONAL_THEMES[theme] ?? [];
  if (categories.length === 0) return [];

  const limit = opts.limit ?? 10;
  // Pull each category (velocity-ranked), then interleave-free merge + dedupe.
  const perCategory = await Promise.all(
    categories.map((category) => byCategory({ ...opts, category, sort: "velocity" })),
  );

  const seen = new Set<string>();
  const merged: ProductItem[] = [];
  for (const items of perCategory) {
    for (const item of items) {
      if (item.sku && !seen.has(item.sku)) {
        seen.add(item.sku);
        merged.push(item);
      }
    }
  }
  return merged.slice(0, limit);
}
