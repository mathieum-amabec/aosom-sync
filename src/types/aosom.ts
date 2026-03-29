/**
 * Raw row from the Aosom TSV feed.
 * Column names match the CSV headers exactly.
 */
export interface AosomRawRow {
  SKU: string;
  Image: string;
  Name: string;
  Price: string;
  custom_tagid: string;
  Category: string;
  Qty: string;
  color: string;
  size: string;
  short_description: string;
  Images: string;
  description: string;
  Gtin: string;
  Weight: string;
  Length: string;
  Width: string;
  Height: string;
  Psin: string;
  Product_Type: string;
  Sin: string;
  "Estimated Arrival Time": string;
  "Out Of Stock Expected": string;
  pdf: string;
  Material: string;
  Package_Num: string;
  Image1: string;
  Image2: string;
  Image3: string;
  Image4: string;
  Image5: string;
  Image6: string;
  Image7: string;
  Box_Size: string;
  Box_Weight: string;
  Video: string;
}

/**
 * Normalized product parsed from a single CSV row (one variant).
 */
export interface AosomProduct {
  sku: string;
  name: string;
  price: number;
  qty: number;
  color: string;
  size: string;
  shortDescription: string;
  description: string; // HTML, with [BRAND NAME] replaced
  images: string[]; // all image URLs consolidated
  gtin: string;
  weight: number;
  dimensions: { length: number; width: number; height: number };
  productType: string; // hierarchical e.g. "Patio & Garden > Gazebos"
  category: string;
  brand: string; // extracted from Name or Category
  material: string;
  psin: string; // parent SKU identifier
  sin: string;
  video: string;
  estimatedArrival: string;
  outOfStockExpected: string;
  packageNum: string;
  boxSize: string;
  boxWeight: string;
  pdf: string;
}

/**
 * A merged product ready for Shopify — groups color/size variants.
 */
export interface AosomMergedProduct {
  /** The grouping key (PSIN or derived base SKU) */
  groupKey: string;
  /** Canonical product name (without color/size suffix) */
  name: string;
  brand: string;
  productType: string;
  category: string;
  description: string;
  shortDescription: string;
  material: string;
  /** Union of all variant images */
  images: string[];
  video: string;
  pdf: string;
  variants: AosomVariant[];
}

export interface AosomVariant {
  sku: string;
  price: number;
  qty: number;
  color: string;
  size: string;
  gtin: string;
  weight: number;
  dimensions: { length: number; width: number; height: number };
  images: string[];
  estimatedArrival: string;
  outOfStockExpected: string;
  packageNum: string;
  boxSize: string;
  boxWeight: string;
}
