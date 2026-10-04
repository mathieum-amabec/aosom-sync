import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/database";
import { MUSIC_CANDIDATES, MUSIC_GROUPS, parsePicks } from "@/lib/ameublo-music-catalog";

/**
 * Studio Ameublo — background-music picker.
 *
 * GET   → the candidates + Mat's picks.
 * PATCH { num, liked: boolean } toggles one track; { comment } saves the free-text note.
 * Picks live in the `ameublo_music_picks` setting: { nums: number[], comment: string }.
 */
const KEY = "ameublo_music_picks";

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const picks = parsePicks(await getSetting(KEY));
  return NextResponse.json({ success: true, data: { candidates: MUSIC_CANDIDATES, groups: MUSIC_GROUPS, picks } });
}

export async function PATCH(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((await getSessionRole()) === "reviewer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }
  const picks = parsePicks(await getSetting(KEY));
  if (typeof body.comment === "string") {
    picks.comment = body.comment.slice(0, 2000);
  } else {
    const num = Number(body.num);
    if (!MUSIC_CANDIDATES.some((c) => c.num === num) || typeof body.liked !== "boolean") {
      return NextResponse.json({ error: "num (1-54) et liked (true/false) requis" }, { status: 400 });
    }
    const set = new Set(picks.nums);
    if (body.liked) set.add(num);
    else set.delete(num);
    picks.nums = [...set].sort((a, b) => a - b);
  }
  await setSetting(KEY, JSON.stringify(picks));
  return NextResponse.json({ success: true, data: { picks } });
}
