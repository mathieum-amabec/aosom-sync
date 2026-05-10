import crypto from "crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { selectRandomTemplate } from "@/lib/content-template-selector";

export const maxDuration = 60;

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const template = await selectRandomTemplate();
  if (!template) {
    return NextResponse.json({ success: false, error: "No active templates" }, { status: 503 });
  }

  // Use VERCEL_URL env var for URL construction — request.url is reliable for Vercel crons
  // (cron scheduler sends real HTTP requests), but VERCEL_URL is the safer fallback.
  const origin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : new URL(request.url).origin;
  const generateUrl = `${origin}/api/social/content/generate`;

  let generateRes: Response;
  try {
    generateRes = await fetch(generateUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ templateSlug: template.slug, language: "fr" }),
    });
  } catch (err) {
    console.error(`[CRON] Fetch to /api/social/content/generate threw:`, err);
    return NextResponse.json(
      { success: false, error: "Generate endpoint unreachable", template: template.slug },
      { status: 503 },
    );
  }

  if (!generateRes.ok) {
    const text = await generateRes.text();
    console.error(`[CRON] Content generation failed for template ${template.slug}:`, text);
    return NextResponse.json(
      { success: false, error: "Generation failed", template: template.slug },
      { status: 500 },
    );
  }

  const result = await generateRes.json() as { draftId: number; hookId: number | null };

  return NextResponse.json({
    success: true,
    template: template.slug,
    contentType: template.content_type,
    draftId: result.draftId,
    hookId: result.hookId,
    triggeredAt: new Date().toISOString(),
  });
}
