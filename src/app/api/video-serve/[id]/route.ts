/**
 * GET /api/video-serve/[id]
 *
 * Streams a draft's rendered MP4 (the Kling/FFmpeg engines write a local file and
 * record its path in facebook_drafts.video_path). This is the canonical PUBLIC
 * url handed to the Meta Graph APIs for Facebook/Instagram Reels — they fetch the
 * video themselves, so a local /tmp path is useless to them; this route exposes it
 * over https.
 *
 * PUBLIC (allow-listed in proxy.ts). Locked down accordingly: serves only the
 * video_path of an existing draft, resolved through resolveVideoPath (which
 * rejects anything outside the video output dir — no arbitrary-file reads).
 * Supports HTTP Range so the platforms (and browsers) can seek.
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import { Readable } from "node:stream";
import { getFacebookDraft } from "@/lib/database";
import { resolveVideoPath } from "@/lib/video-engines/video-store";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = Number.parseInt(idStr, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid draft id" }, { status: 400 });
  }

  const draft = await getFacebookDraft(id);
  if (!draft || !draft.videoPath) {
    return NextResponse.json({ error: "No video for this draft" }, { status: 404 });
  }

  let filePath: string;
  try {
    filePath = resolveVideoPath(draft.videoPath);
  } catch {
    // video_path escaped the allowed dir — treat as not found, never leak the path.
    return NextResponse.json({ error: "No video for this draft" }, { status: 404 });
  }
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Video file missing" }, { status: 404 });
  }

  const size = fs.statSync(filePath).size;
  const baseHeaders: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
  };

  // Range request (Meta/browsers seek): serve the requested byte window as 206.
  const range = request.headers.get("range");
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (match && (match[1] !== "" || match[2] !== "")) {
    let start: number;
    let end: number;
    if (match[1] === "") {
      // Suffix range `bytes=-N` → the last N bytes.
      const n = Number.parseInt(match[2], 10);
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number.parseInt(match[1], 10);
      end = match[2] === "" ? size - 1 : Number.parseInt(match[2], 10);
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    end = Math.min(end, size - 1);
    const stream = fs.createReadStream(filePath, { start, end });
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  // Full file.
  const stream = fs.createReadStream(filePath);
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}
