import { NextResponse } from "next/server";
import { requireStudioAdmin } from "@/lib/studio/guard";
import { getStudioTop } from "@/lib/studio/top";

/** GET /api/studio/top — Aosom best sellers (14-day stock drop), one row per product. */
export async function GET(request: Request) {
  const denied = await requireStudioAdmin();
  if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get("limit")) || 50;
    const windowDays = [7, 14, 30].includes(Number(params.get("days"))) ? Number(params.get("days")) : 14;
    const products = await getStudioTop({ limit, windowDays });
    return NextResponse.json({ success: true, data: { products, windowDays } });
  } catch (err) {
    console.error("[API] /api/studio/top failed:", err);
    return NextResponse.json({ success: false, error: "Impossible de charger le top des ventes" }, { status: 500 });
  }
}
