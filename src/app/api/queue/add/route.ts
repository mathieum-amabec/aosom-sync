import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import {
  addToQueue,
  getOccupiedQueueSlots,
  QueueSlotTakenError,
  type QueueContentType,
  type QueuePlatform,
} from "@/lib/database";
import { nextFreeSlot } from "@/lib/draft-scheduler";

const CONTENT_TYPES: ReadonlySet<QueueContentType> = new Set([
  "social",
  "draft",
  "blog",
]);
const PLATFORMS: ReadonlySet<QueuePlatform> = new Set([
  "facebook",
  "instagram",
  "both",
  "shopify_blog",
]);

// Bound stored input. payload lands in a TEXT column the cron later parses; content_id is
// a foreign reference. Caps keep a single request from bloating a Turso row.
const MAX_CONTENT_ID = 256;
const MAX_PAYLOAD_BYTES = 100_000;

/**
 * POST /api/queue/add
 *
 * Body: { content_type, content_id, platform, payload }
 *   - content_type: 'social' | 'draft' | 'blog'
 *   - platform:     'facebook' | 'instagram' | 'both' | 'shopify_blog'
 *   - content_id:   ID of the source draft/post
 *   - payload:      content to publish (object → JSON-stringified, or a string)
 *
 * Computes the next free posting slot for `platform` (M/W/F 10:00 EST = 15:00 UTC
 * grid, one item per platform per slot — see draft-scheduler), enqueues the item,
 * and returns { queued: true, scheduled_at }.
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
    content_type?: unknown;
    content_id?: unknown;
    platform?: unknown;
    payload?: unknown;
  };

  const contentType = obj.content_type;
  if (typeof contentType !== "string" || !CONTENT_TYPES.has(contentType as QueueContentType)) {
    return NextResponse.json(
      { error: "`content_type` must be one of: social, draft, blog" },
      { status: 400 },
    );
  }

  const platform = obj.platform;
  if (typeof platform !== "string" || !PLATFORMS.has(platform as QueuePlatform)) {
    return NextResponse.json(
      { error: "`platform` must be one of: facebook, instagram, both, shopify_blog" },
      { status: 400 },
    );
  }

  const contentId = obj.content_id;
  if (typeof contentId !== "string" || contentId.trim() === "") {
    return NextResponse.json(
      { error: "`content_id` must be a non-empty string" },
      { status: 400 },
    );
  }
  if (contentId.length > MAX_CONTENT_ID) {
    return NextResponse.json(
      { error: `\`content_id\` exceeds ${MAX_CONTENT_ID} chars` },
      { status: 400 },
    );
  }

  if (obj.payload === undefined || obj.payload === null) {
    return NextResponse.json({ error: "`payload` is required" }, { status: 400 });
  }
  // Accept either a pre-stringified JSON payload or an object/array to serialize.
  const payload =
    typeof obj.payload === "string" ? obj.payload : JSON.stringify(obj.payload);
  if (payload.length > MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      { error: `\`payload\` exceeds ${MAX_PAYLOAD_BYTES} chars` },
      { status: 400 },
    );
  }

  // Next free slot: walk the posting grid from now, skipping slots already taken by an
  // active item on the same platform. Two concurrent requests can read the same occupancy
  // and pick the same slot; the partial unique index rejects the loser with
  // QueueSlotTakenError, so retry past the now-taken slot a few times before giving up.
  const nowSec = Math.floor(Date.now() / 1000);
  const taken = new Set(await getOccupiedQueueSlots(platform));
  for (let attempt = 0; attempt < 5; attempt++) {
    const scheduledAt = nextFreeSlot(nowSec, taken);
    if (scheduledAt === null) {
      return NextResponse.json(
        { error: "No free publication slot available within the scheduling horizon" },
        { status: 503 },
      );
    }
    try {
      await addToQueue({
        contentType: contentType as QueueContentType,
        contentId,
        platform: platform as QueuePlatform,
        payload,
        scheduledAt,
      });
      return NextResponse.json({ queued: true, scheduled_at: scheduledAt });
    } catch (err) {
      if (err instanceof QueueSlotTakenError) {
        taken.add(scheduledAt); // lost the race for this slot — try the next one
        continue;
      }
      throw err;
    }
  }
  return NextResponse.json(
    { error: "Could not reserve a free slot after multiple attempts, please retry" },
    { status: 503 },
  );
}
