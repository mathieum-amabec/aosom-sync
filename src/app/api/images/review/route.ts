/**
 * pos-1 image review queue — list and decide.
 *
 * GET  /api/images/review?status=pending      → rows awaiting a decision (default "pending")
 * POST /api/images/review {id, action}        → "approve" applies the swap on Shopify,
 *                                               "reject" leaves the product untouched.
 *
 * THIS is the only path that turns a Vision verdict into a Shopify write. The daily guard in
 * queue mode never writes; it only proposes. Approving is therefore the human confirmation
 * step the compliance spec asks for.
 */
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { moveImageToFirstPosition } from "@/lib/shopify-client";
import {
  listImageReviews,
  getImageReview,
  setImageReviewStatus,
  countImageReviews,
  type ImageReviewRow,
} from "@/lib/database";

const STATUSES = ["pending", "approved", "rejected", "applied", "failed", "all"] as const;
type StatusParam = (typeof STATUSES)[number];

export async function GET(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("status") ?? "pending";
  const status: StatusParam = (STATUSES as readonly string[]).includes(raw) ? (raw as StatusParam) : "pending";
  const limitRaw = parseInt(searchParams.get("limit") ?? "200", 10);
  const limit = Math.min(500, Math.max(1, Number.isNaN(limitRaw) ? 200 : limitRaw));

  try {
    const [rows, counts] = await Promise.all([
      listImageReviews(status as ImageReviewRow["status"] | "all", limit),
      countImageReviews(),
    ]);
    return NextResponse.json({ rows, counts });
  } catch (err) {
    console.error("[API] GET /api/images/review failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { id?: unknown; action?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = Number(body.id);
  const action = String(body.action ?? "");
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "id must be a positive integer" }, { status: 400 });
  }
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: 'action must be "approve" or "reject"' }, { status: 400 });
  }

  try {
    const row = await getImageReview(id);
    if (!row) return NextResponse.json({ error: "Review not found" }, { status: 404 });
    if (row.status !== "pending") {
      // Already decided — report it rather than re-applying a swap on a second click.
      return NextResponse.json({ error: `Review already ${row.status}`, row }, { status: 409 });
    }

    if (action === "reject") {
      await setImageReviewStatus(id, "rejected");
      return NextResponse.json({ ok: true, status: "rejected" });
    }

    // A feed-only proposal has no Shopify image to promote: the photo would have to be
    // uploaded to the product first. Refuse rather than pretend the swap happened.
    if (!row.proposedImageId) {
      return NextResponse.json({
        error: "L'image propre n'existe que dans le flux Aosom — elle doit d'abord être téléversée sur le produit Shopify.",
        row,
      }, { status: 422 });
    }

    const verified = await moveImageToFirstPosition(row.shopifyProductId, row.proposedImageId);
    if (!verified) {
      await setImageReviewStatus(id, "failed", "Shopify n'a pas confirmé le réordonnancement");
      return NextResponse.json({ error: "Shopify n'a pas confirmé le réordonnancement" }, { status: 502 });
    }

    await setImageReviewStatus(id, "applied");
    return NextResponse.json({ ok: true, status: "applied" });
  } catch (err) {
    console.error("[API] POST /api/images/review failed:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    try {
      await setImageReviewStatus(id, "failed", message);
    } catch {
      // best-effort
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
