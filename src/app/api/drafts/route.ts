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
  const since = sinceParam ? Number(sinceParam) : undefined;
  const until = untilParam ? Number(untilParam) : undefined;

  const page = Math.max(1, Number(searchParams.get("page") ?? "1"));
  const pageSize = Math.min(50, Math.max(1, Number(searchParams.get("pageSize") ?? "20")));

  try {
    const result = await getDraftsForReview({ statuses, triggerType, hook, since, until, page, pageSize });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[API] GET /api/drafts failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
