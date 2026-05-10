import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getDraftsForReview } from "@/lib/database";

export async function GET(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);

  const statusParam = searchParams.get("status");
  const statuses = statusParam ? statusParam.split(",").filter(Boolean) : undefined;

  const triggerType = searchParams.get("triggerType") ?? undefined;

  const hookParam = searchParams.get("hook");
  const hook = hookParam === "with" || hookParam === "without" ? hookParam : "all";

  const sinceParam = searchParams.get("since");
  const untilParam = searchParams.get("until");
  const sinceNum = sinceParam ? parseInt(sinceParam, 10) : NaN;
  const untilNum = untilParam ? parseInt(untilParam, 10) : NaN;
  const since = !isNaN(sinceNum) ? sinceNum : undefined;
  const until = !isNaN(untilNum) ? untilNum : undefined;

  const pageRaw = parseInt(searchParams.get("page") ?? "1", 10);
  const page = Math.max(1, isNaN(pageRaw) ? 1 : pageRaw);
  const pageSizeRaw = parseInt(searchParams.get("pageSize") ?? "20", 10);
  const pageSize = Math.min(50, Math.max(1, isNaN(pageSizeRaw) ? 20 : pageSizeRaw));

  try {
    const result = await getDraftsForReview({ statuses, triggerType, hook, since, until, page, pageSize });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[API] GET /api/drafts failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
