import { NextResponse } from "next/server";
import { getAllCollectionMappings, upsertCollectionMappingsBatch } from "@/lib/database";
import type { CollectionMapping } from "@/lib/database";

export async function GET() {
  try {
    const mappings = await getAllCollectionMappings();
    return NextResponse.json({ success: true, data: mappings });
  } catch (err) {
    console.error("[API] /api/collections/mappings GET failed:", err);
    return NextResponse.json({ success: false, error: "Failed to load mappings" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { mappings } = await request.json() as { mappings: CollectionMapping[] };
    if (!Array.isArray(mappings)) {
      return NextResponse.json({ success: false, error: "mappings array required" }, { status: 400 });
    }
    const valid = mappings.filter(
      m => m.aosomCategory && m.shopifyCollectionId && m.shopifyCollectionTitle
    );
    if (valid.length > 0) {
      await upsertCollectionMappingsBatch(valid);
    }
    return NextResponse.json({ success: true, saved: valid.length });
  } catch (err) {
    console.error("[API] /api/collections/mappings POST failed:", err);
    return NextResponse.json({ success: false, error: "Failed to save mappings" }, { status: 500 });
  }
}
