import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import {
  createVideoJob,
  getVideoJobs,
  type VideoEngine,
  type VideoContentType,
  type VideoLocale,
  type VideoStatus,
} from "@/lib/database";

const ENGINES: VideoEngine[] = ["ffmpeg", "kling", "creatomate"];
const CONTENT_TYPES: VideoContentType[] = ["product", "lifestyle", "promo"];
const LOCALES: VideoLocale[] = ["fr", "en"];
const STATUSES: VideoStatus[] = [
  "pending", "generating", "ready", "error", "approved", "rejected",
];

/**
 * GET /api/videos — list video jobs (paginated, filterable by status).
 *
 * Query: ?status=pending,generating&page=1&pageSize=50
 */
export async function GET(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);

  const statusParam = searchParams.get("status");
  const statuses = statusParam
    ? statusParam.split(",").map((s) => s.trim()).filter((s): s is VideoStatus =>
        (STATUSES as string[]).includes(s))
    : undefined;

  const pageRaw = parseInt(searchParams.get("page") ?? "1", 10);
  const page = Math.max(1, isNaN(pageRaw) ? 1 : pageRaw);
  const pageSizeRaw = parseInt(searchParams.get("pageSize") ?? "50", 10);
  const pageSize = Math.min(100, Math.max(1, isNaN(pageSizeRaw) ? 50 : pageSizeRaw));

  try {
    const { jobs, total } = await getVideoJobs({ status: statuses, page, pageSize });
    return NextResponse.json({
      success: true,
      data: { jobs, pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) } },
    });
  } catch (err) {
    console.error("[API] GET /api/videos failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/videos — create a new video job (status=pending).
 *
 * Body: { engine, contentType, locale, productSkus?: string[] }
 */
export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const obj = body as {
    engine?: unknown; contentType?: unknown; locale?: unknown; productSkus?: unknown;
  };

  if (typeof obj.engine !== "string" || !(ENGINES as string[]).includes(obj.engine)) {
    return NextResponse.json({ error: `\`engine\` must be one of: ${ENGINES.join(", ")}` }, { status: 400 });
  }
  if (typeof obj.contentType !== "string" || !(CONTENT_TYPES as string[]).includes(obj.contentType)) {
    return NextResponse.json({ error: `\`contentType\` must be one of: ${CONTENT_TYPES.join(", ")}` }, { status: 400 });
  }
  if (typeof obj.locale !== "string" || !(LOCALES as string[]).includes(obj.locale)) {
    return NextResponse.json({ error: `\`locale\` must be one of: ${LOCALES.join(", ")}` }, { status: 400 });
  }
  let productSkus: string[] = [];
  if (obj.productSkus !== undefined) {
    if (!Array.isArray(obj.productSkus) || !obj.productSkus.every((s) => typeof s === "string")) {
      return NextResponse.json({ error: "`productSkus` must be an array of strings" }, { status: 400 });
    }
    productSkus = obj.productSkus as string[];
  }

  try {
    const job = await createVideoJob({
      engine: obj.engine as VideoEngine,
      contentType: obj.contentType as VideoContentType,
      locale: obj.locale as VideoLocale,
      productSkus,
    });
    return NextResponse.json({ success: true, data: job }, { status: 201 });
  } catch (err) {
    console.error("[API] POST /api/videos failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
