import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import {
  bestSellers,
  byCategory,
  priceDrops,
  seasonal,
  lowStock,
  productsBySkus,
  type ProductItem,
} from "@/lib/selectors";

/**
 * GET /api/slideshow/products-preview?mode=best_sellers&limit=10&category=Patio&theme=ete&language=fr
 *
 * Dry-run of PRODUCT SELECTION: returns the products that WOULD feed a slideshow
 * for the chosen selection mode, with Shopify-CDN images, derived compare-at and
 * discount_pct. No render, no Blob write. Drives the "Voir les produits
 * sélectionnés" grid in the generation panel.
 *
 * Modes: best_sellers | by_category | price_drops | seasonal | low_stock | manual
 * Admin-only (same gate as /api/slideshow/preview — reviewers can't drive selection).
 */
const MODES = ["best_sellers", "by_category", "price_drops", "seasonal", "low_stock", "manual"] as const;
type Mode = (typeof MODES)[number];

function isMode(v: string | null): v is Mode {
  return v !== null && (MODES as readonly string[]).includes(v);
}

export async function GET(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const q = new URL(request.url).searchParams;
  const mode = q.get("mode");
  if (!isMode(mode)) {
    return NextResponse.json(
      { error: `\`mode\` must be one of ${MODES.join(", ")}` },
      { status: 400 },
    );
  }

  const language = q.get("language") === "en" ? "en" : "fr";
  const limitRaw = Number(q.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 20) : 10;

  try {
    let products: ProductItem[];
    switch (mode) {
      case "best_sellers":
        products = await bestSellers({ limit, language, windowDays: 14 });
        break;
      case "by_category": {
        const category = q.get("category")?.trim();
        if (!category) {
          return NextResponse.json({ error: "`category` is required for mode=by_category" }, { status: 400 });
        }
        products = await byCategory({ limit, language, category, sort: "velocity" });
        break;
      }
      case "price_drops":
        products = await priceDrops({ limit, language, minPct: 10 });
        break;
      case "seasonal": {
        const theme = q.get("theme")?.trim();
        if (!theme) {
          return NextResponse.json({ error: "`theme` is required for mode=seasonal" }, { status: 400 });
        }
        products = await seasonal(theme, { limit, language });
        break;
      }
      case "low_stock":
        products = await lowStock({ limit, language, threshold: 5 });
        break;
      case "manual": {
        const skus = q
          .getAll("skus")
          .flatMap((s) => s.split(","))
          .map((s) => s.trim())
          .filter(Boolean);
        if (skus.length === 0) {
          return NextResponse.json({ error: "`skus` is required for mode=manual" }, { status: 400 });
        }
        products = await productsBySkus(skus, { language });
        break;
      }
      default:
        return NextResponse.json({ error: "unsupported mode" }, { status: 400 });
    }

    return NextResponse.json({ products, count: products.length, mode });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
