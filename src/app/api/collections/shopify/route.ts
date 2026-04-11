import { NextResponse } from "next/server";
import { fetchAllCollections } from "@/lib/shopify-client";

export async function GET() {
  try {
    const collections = await fetchAllCollections();
    return NextResponse.json({ success: true, data: collections });
  } catch (err) {
    console.error("[API] /api/collections/shopify failed:", err);
    return NextResponse.json({ success: false, error: "Failed to fetch Shopify collections" }, { status: 500 });
  }
}
