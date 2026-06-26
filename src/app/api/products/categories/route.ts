import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getImportedProductTypes } from "@/lib/database";

/**
 * GET /api/products/categories
 *
 * Distinct product_types among imported products (have a Shopify id), sorted A→Z.
 * Powers the category dropdown in the slideshow generation panel.
 *
 * Admin-only. Cached in-process for 10 minutes — categories change only on sync.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { data: string[]; expiry: number } | null = null;

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (cache && cache.expiry > Date.now()) {
    return NextResponse.json({ success: true, categories: cache.data, cached: true });
  }

  try {
    const categories = await getImportedProductTypes();
    cache = { data: categories, expiry: Date.now() + CACHE_TTL_MS };
    return NextResponse.json({ success: true, categories, cached: false });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
