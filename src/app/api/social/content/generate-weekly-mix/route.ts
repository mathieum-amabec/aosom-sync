import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";

const VALID_LANGUAGES = new Set(["fr", "en"]);

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

    const { language, week_of } = body as {
      language?: unknown;
      week_of?: unknown;
    };

    if (!language || !VALID_LANGUAGES.has(language as string)) {
      return NextResponse.json(
        { success: false, error: "language is required and must be 'fr' or 'en'" },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "NOT_IMPLEMENTED",
        message: "Weekly mix generation will be available after creative session — see TODOS.md",
        received: { language, week_of },
      },
      { status: 501 }
    );
  } catch (err) {
    console.error("[API] /api/social/content/generate-weekly-mix POST failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
