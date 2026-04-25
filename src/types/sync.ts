import type { AosomMergedProduct, AosomVariant } from "./aosom";

/**
 * Represents a product currently in our Shopify store.
 * Minimal shape needed for diffing.
 */
export interface ShopifyExistingProduct {
  shopifyId: string;
  title: string;
  status: "active" | "draft" | "archived";
  variants: ShopifyExistingVariant[];
  images: string[];
  bodyHtml: string;
  productType: string;
}

export interface ShopifyExistingVariant {
  variantId: string;
  sku: string;
  price: number;
  inventoryQuantity: number;
  option1: string | null; // color
  option2: string | null; // size
  weight: number;
  gtin: string;
}

export type ChangeType =
  | "price"
  | "stock"
  | "images"
  | "description"
  | "title"
  | "new_variant"
  | "removed_variant"
  | "new_product"
  | "removed_product";

export interface FieldChange {
  field: ChangeType;
  sku: string;
  oldValue: string | number | null;
  newValue: string | number | null;
}

export interface ProductDiff {
  /** Shopify product ID (null if new product) */
  shopifyId: string | null;
  groupKey: string;
  productName: string;
  action: "create" | "update" | "archive";
  changes: FieldChange[];
  /** The merged Aosom product (source of truth for creates/updates) */
  aosomProduct: AosomMergedProduct | null;
}

export interface SyncRun {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: "running" | "completed" | "failed";
  totalProducts: number;
  created: number;
  updated: number;
  archived: number;
  errors: number;
  errorMessages: string[];
  timingMs?: Record<string, number>;
}

export interface SyncLogEntry {
  id: string;
  syncRunId: string;
  timestamp: string;
  shopifyProductId: string | null;
  sku: string;
  action: "create" | "update" | "archive";
  field: ChangeType;
  oldValue: string | null;
  newValue: string | null;
}
