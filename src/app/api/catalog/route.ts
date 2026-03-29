import { NextResponse } from "next/server";
import { getCatalogProducts } from "@/lib/database";

/**
 * GET /api/catalog — Browse catalog from Turso snapshots.
 * Filters: productType, search, minPrice, maxPrice, inStock, page, limit
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const params = url.searchParams;

    const page = parseInt(params.get("page") || "1", 10);
    const limit = Math.min(parseInt(params.get("limit") || "50", 10), 200);

    const { products, total, productTypes } = await getCatalogProducts({
      productType: params.get("productType") || undefined,
      search: params.get("search") || undefined,
      minPrice: params.get("minPrice") ? parseFloat(params.get("minPrice")!) : undefined,
      maxPrice: params.get("maxPrice") ? parseFloat(params.get("maxPrice")!) : undefined,
      inStock: params.get("inStock") === "true",
      page,
      limit,
    });

    return NextResponse.json({
      products,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      productTypes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const maxDuration = 30;
