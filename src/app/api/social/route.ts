import { NextResponse } from "next/server";
import {
  getFacebookDrafts,
  getFacebookDraft,
  updateFacebookDraft,
  deleteFacebookDraft,
  createFacebookDraft,
} from "@/lib/database";
import { publishWithImage, publishText } from "@/lib/facebook-client";
import { triggerNewProduct, triggerPriceDrop, triggerStockHighlight } from "@/jobs/job4-social";
import { testConnection as testFacebookConnection } from "@/lib/facebook-client";

/**
 * GET /api/social — List drafts with optional status filter.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") || undefined;
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const drafts = getFacebookDrafts({ status, limit });
    return NextResponse.json({ success: true, data: drafts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * POST /api/social — Perform actions on drafts.
 * Actions: generate, approve, reject, schedule, publish, update, delete
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action } = body;

    // Validate id for actions that require it
    if (["approve", "reject", "schedule", "publish", "update", "delete"].includes(action)) {
      if (!body.id || typeof body.id !== "number" || body.id < 1) {
        return NextResponse.json({ success: false, error: "Valid numeric id required" }, { status: 400 });
      }
    }

    switch (action) {
      case "generate": {
        const { triggerType, sku, oldPrice, newPrice } = body;
        let result;
        if (triggerType === "new_product") {
          result = await triggerNewProduct(sku);
        } else if (triggerType === "price_drop") {
          result = await triggerPriceDrop(sku, oldPrice, newPrice);
        } else if (triggerType === "stock_highlight") {
          result = await triggerStockHighlight();
        } else {
          return NextResponse.json({ success: false, error: "Invalid trigger type" }, { status: 400 });
        }
        return NextResponse.json({ success: true, data: result });
      }

      case "approve": {
        updateFacebookDraft(body.id, { status: "approved" });
        return NextResponse.json({ success: true, data: getFacebookDraft(body.id) });
      }

      case "reject": {
        updateFacebookDraft(body.id, { status: "rejected" });
        return NextResponse.json({ success: true, data: getFacebookDraft(body.id) });
      }

      case "schedule": {
        const scheduledAt = body.scheduledAt; // Unix timestamp
        if (!scheduledAt) return NextResponse.json({ success: false, error: "scheduledAt required" }, { status: 400 });
        updateFacebookDraft(body.id, { status: "scheduled", scheduled_at: scheduledAt });
        return NextResponse.json({ success: true, data: getFacebookDraft(body.id) });
      }

      case "publish": {
        const draft = getFacebookDraft(body.id);
        if (!draft) return NextResponse.json({ success: false, error: "Draft not found" }, { status: 404 });

        let result;
        if (draft.imagePath) {
          result = await publishWithImage({
            caption: draft.postText,
            imagePath: draft.imagePath,
            scheduledAt: draft.scheduledAt || undefined,
          });
        } else {
          result = await publishText({
            message: draft.postText,
            scheduledAt: draft.scheduledAt || undefined,
          });
        }

        const now = Math.floor(Date.now() / 1000);
        updateFacebookDraft(body.id, {
          status: "published",
          published_at: now,
          facebook_post_id: result.postId,
        });
        return NextResponse.json({ success: true, data: getFacebookDraft(body.id) });
      }

      case "update": {
        const { id, postText } = body;
        if (postText) updateFacebookDraft(id, { post_text: postText });
        return NextResponse.json({ success: true, data: getFacebookDraft(id) });
      }

      case "delete": {
        deleteFacebookDraft(body.id);
        return NextResponse.json({ success: true });
      }

      case "test-prompt": {
        const { promptText } = body;
        if (!promptText || typeof promptText !== "string") {
          return NextResponse.json({ success: false, error: "promptText required" }, { status: 400 });
        }
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        const { env: cfgEnv, CLAUDE } = await import("@/lib/config");
        const client = new Anthropic({ apiKey: cfgEnv.anthropicApiKey });
        const message = await client.messages.create({
          model: CLAUDE.MODEL,
          max_tokens: CLAUDE.MAX_TOKENS_SOCIAL,
          messages: [{ role: "user", content: promptText }],
        });
        const text = message.content[0].type === "text" ? message.content[0].text.trim() : "";
        return NextResponse.json({ success: true, data: { text } });
      }

      case "test-facebook": {
        const result = await testFacebookConnection();
        return NextResponse.json({ success: true, data: result });
      }

      default:
        return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const maxDuration = 120;
