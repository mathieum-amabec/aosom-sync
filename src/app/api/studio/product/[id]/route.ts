import { NextResponse } from "next/server";
import { requireStudioAdmin } from "@/lib/studio/guard";
import { fetchProductGallery } from "@/lib/studio/shopify";
import { listStudioImages, listStudioRenders, effectiveStatus } from "@/lib/studio/db";

/**
 * GET /api/studio/product/:shopifyProductId?sku=… — everything the picker needs for one product:
 * the Shopify gallery, Mat's extra images (uploads + AI retouches) and past renders.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStudioAdmin();
  if (denied) return denied;
  const { id } = await params;
  const sku = new URL(request.url).searchParams.get("sku")?.trim() ?? "";
  if (!/^\d+$/.test(id) || !sku) {
    return NextResponse.json({ success: false, error: "Produit ou SKU invalide" }, { status: 400 });
  }
  try {
    const [gallery, extra, renders] = await Promise.all([fetchProductGallery(id), listStudioImages(sku), listStudioRenders(sku)]);
    if (!gallery) return NextResponse.json({ success: false, error: "Produit introuvable sur Shopify" }, { status: 404 });
    return NextResponse.json({
      success: true,
      data: {
        title: gallery.title,
        handle: gallery.handle,
        images: gallery.images,
        extraImages: extra,
        renders: renders.map((r) => ({ ...r, status: effectiveStatus(r) })),
      },
    });
  } catch (err) {
    console.error(`[API] /api/studio/product/${id} failed:`, err);
    return NextResponse.json({ success: false, error: "Impossible de charger le produit" }, { status: 500 });
  }
}
