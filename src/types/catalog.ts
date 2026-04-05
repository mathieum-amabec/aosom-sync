export interface CatalogProduct {
  sku: string;
  name: string;
  price: number;
  qty: number;
  color: string;
  product_type: string;
  psin: string;
  image?: string;
  prev_price?: number;
  import_status: string | null;
}

export interface CatalogResponse {
  products: CatalogProduct[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
  productTypes: { type: string; count: number }[];
}
