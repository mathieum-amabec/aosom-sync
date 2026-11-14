import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { generateUgcReinjectionBatch, DEFAULT_UGC_REINJECT_BATCH } from "@/jobs/job-ugc-reinject";

/**
 * POST /api/social/ugc-reinject — manual trigger: generate up to `count` new
 * facebook_drafts (status 'draft') from customer UGC videos never used in social
 * content before. Admin-only, deliberately NOT on the daily cron (see
 * job-ugc-reinject.ts for why) — an operator runs this when they want to top up the
 * social queue from the UGC backlog. Every draft still needs manual approval via
 * /social or /drafts before it can ever publish.
 */
export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let count = DEFAULT_UGC_REINJECT_BATCH;
  try {
    const body = (await request.json()) as { count?: number };
    if (typeof body.count === "number" && Number.isInteger(body.count) && body.count > 0) {
      count = Math.min(body.count, 20); // hard ceiling — never flood the approval queue in one call
    }
  } catch {
    // no body / not JSON — use the default batch size
  }

  const results = await generateUgcReinjectionBatch(count);
  return NextResponse.json({ success: true, created: results.length, drafts: results });
}
