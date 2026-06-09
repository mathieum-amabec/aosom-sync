/**
 * GET /api/video-serve/:id — public video delivery for a video_jobs row.
 *
 *  - video_url set  → 302 redirect to the external URL (Vercel Blob / Kling / etc.)
 *  - video_path set → stream the local MP4 with Range support
 *  - neither        → 404
 *
 * PUBLIC (allow-listed in proxy.ts) so the Facebook / Instagram Graph APIs can
 * fetch the video themselves when publishing a Reel — they require a hosted URL
 * with no session. The only request input is the numeric id; video_url and
 * video_path come from the DB row (pipeline-controlled), never from the request,
 * so there is no path-traversal or open-redirect surface from user input. The
 * redirect target is still validated to be http(s) as defense in depth against a
 * poisoned DB value.
 */
import { NextResponse } from "next/server";
import { createReadStream, promises as fsp } from "fs";
import { Readable } from "stream";
import { getVideoJob } from "@/lib/database";

export const runtime = "nodejs";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function toWebStream(nodeStream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await params;
  const id = Number.parseInt(idStr, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid video job id" }, { status: 400 });
  }

  const job = await getVideoJob(id);
  if (!job) {
    return new NextResponse(null, { status: 404 });
  }

  // Prefer the external URL when present.
  if (job.video_url && isHttpUrl(job.video_url)) {
    return NextResponse.redirect(job.video_url, 302);
  }

  // Otherwise stream the local file.
  if (job.video_path) {
    let stat;
    try {
      stat = await fsp.stat(job.video_path);
    } catch {
      return new NextResponse(null, { status: 404 });
    }
    if (!stat.isFile()) {
      return new NextResponse(null, { status: 404 });
    }

    const size = stat.size;
    const range = request.headers.get("range");

    // Honour byte-range requests (video players + Graph API seek with these).
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match && (match[1] || match[2])) {
        let start = match[1] ? parseInt(match[1], 10) : 0;
        let end = match[2] ? parseInt(match[2], 10) : size - 1;
        if (Number.isNaN(start)) start = 0;
        if (Number.isNaN(end) || end >= size) end = size - 1;
        if (start > end || start >= size) {
          return new NextResponse(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
          });
        }
        return new NextResponse(toWebStream(createReadStream(job.video_path, { start, end })), {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": String(end - start + 1),
          },
        });
      }
    }

    return new NextResponse(toWebStream(createReadStream(job.video_path)), {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": String(size),
      },
    });
  }

  return new NextResponse(null, { status: 404 });
}
