import { NextResponse } from "next/server";
import { API } from "@/lib/config";
import { parseBoolParam } from "@/lib/catalog-filters";
import { getCostwayCatalog, getCostwaySummary, getImportSummary } from "@/lib/costway/db";
import { getCostwayLastSync } from "@/lib/costway/sync";

/**
 * GET /api/costway — browse the Costway catalogue, one row per product (Item No).
 * Filters: search, category, inStock, minPrice, maxPrice, promoTag, imported (only|exclude|all),
 * batch, sort, page, limit.
 * Session-protected by src/proxy.ts like every non-public route.
 */
export async function GET(request: Request) {
  try {
    const start = performance.now();
    const params = new URL(request.url).searchParams;
    const page = Math.max(1, parseInt(params.get("page") || "1", 10) || 1);
    const limit = Math.min(
      Math.max(1, parseInt(params.get("limit") || String(API.DEFAULT_PAGE_SIZE), 10) || API.DEFAULT_PAGE_SIZE),
      API.MAX_PAGE_SIZE,
    );
    const priceParam = (k: string) => {
      const v = params.get(k);
      return v ? parseFloat(v) : undefined;
    };

    const importedParam = params.get("imported");
    const imported = importedParam === "only" || importedParam === "exclude" ? importedParam : "all";

    const [{ products, total }, summary, lastSync, importSummary] = await Promise.all([
      getCostwayCatalog({
        search: params.get("search")?.trim() || undefined,
        topCategory: params.get("category") || undefined,
        inStock: parseBoolParam(params.get("inStock")),
        minPrice: priceParam("minPrice"),
        maxPrice: priceParam("maxPrice"),
        promoTag: params.get("promoTag") || undefined,
        imported,
        batch: params.get("batch")?.trim() || undefined,
        sort: params.get("sort") || undefined,
        page,
        limit,
      }),
      getCostwaySummary(),
      getCostwayLastSync(),
      getImportSummary(),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        products,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        summary,
        lastSync,
        importSummary,
      },
      _timing: { ms: Math.round(performance.now() - start) },
    });
  } catch (err) {
    console.error(`[API] /api/costway failed:`, err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
