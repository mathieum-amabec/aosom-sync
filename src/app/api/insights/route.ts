import { NextResponse } from "next/server";
import { getPriceChanges, getTopSellers } from "@/lib/database";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const type = url.searchParams.get("type");

    if (type === "price-changes") {
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const changes = await getPriceChanges(limit);
      return NextResponse.json({ changes });
    }

    if (type === "top-sellers") {
      const limit = parseInt(url.searchParams.get("limit") || "30", 10);
      const sellers = await getTopSellers(limit);
      return NextResponse.json({ sellers });
    }

    // Return both
    const [changes, sellers] = await Promise.all([
      getPriceChanges(20),
      getTopSellers(20),
    ]);
    return NextResponse.json({ changes, sellers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
