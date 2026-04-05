import { NextResponse } from "next/server";
import { getPriceChanges, getTopSellers } from "@/lib/database";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const type = url.searchParams.get("type");

    if (type === "price-changes") {
      const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50), 200);
      const changes = getPriceChanges(limit);
      return NextResponse.json({ changes });
    }

    if (type === "top-sellers") {
      const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "30", 10) || 30), 200);
      const sellers = getTopSellers(limit);
      return NextResponse.json({ sellers });
    }

    // Return both
    const [changes, sellers] = [getPriceChanges(20), getTopSellers(20)];
    return NextResponse.json({ changes, sellers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
