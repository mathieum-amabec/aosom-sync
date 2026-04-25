import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";

const VALID_LANGUAGES = new Set(["fr", "en"]);
const VALID_CONTENT_TYPES = new Set(["informative", "entertaining", "engagement"]);

export async function POST(request: Request) {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    if ((await getSessionRole()) === "reviewer") {
      return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const { template_slug, content_type, category_filter, language } = body as {
      template_slug?: unknown;
      content_type?: unknown;
      category_filter?: unknown;
      language?: unknown;
    };

    if (!language || !VALID_LANGUAGES.has(language as string)) {
      return NextResponse.json(
        { success: false, error: "language is required and must be 'fr' or 'en'" },
        { status: 400 }
      );
    }

    if (content_type !== undefined && !VALID_CONTENT_TYPES.has(content_type as string)) {
      return NextResponse.json(
        { success: false, error: "content_type must be 'informative', 'entertaining', or 'engagement'" },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "NOT_IMPLEMENTED",
        message: "Content generation will be available after creative session — see TODOS.md",
        received: { template_slug, content_type, language, category_filter },
      },
      { status: 501 }
    );
  } catch (err) {
    console.error("[API] /api/social/content/generate POST failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
