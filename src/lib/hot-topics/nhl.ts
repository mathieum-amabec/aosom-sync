/**
 * Hard facts about the Canadiens from the public NHL API (no key): the score of the last game and
 * the next game. A score cannot be "invented by the model" — the post is built around it, and the
 * generator's validation rejects any number that is not in the source text.
 *
 * Only TEAM names are used (never a player): the risk review's rule is that players are named only
 * for a decision or a game performance taken from a headline, never from a bare statistic feed.
 */
import type { TopicCandidate } from "./sources";

const SCHEDULE_URL = "https://api-web.nhle.com/v1/club-schedule-season/MTL/now";
const FETCH_TIMEOUT_MS = 12_000;
/** A game is "news" for this long after the puck drops (game ≈ 2h45 + the next morning). */
const LAST_GAME_WINDOW_H = 36;
/** An upcoming game is announced when it starts within this many hours. */
const NEXT_GAME_WINDOW_H = 30;
const GAME_LENGTH_SEC = 10_200;

interface NhlTeam {
  commonName?: { default?: string };
  placeName?: { default?: string; fr?: string };
  placeNameWithPreposition?: { default?: string; fr?: string };
  abbrev?: string;
  score?: number;
}

export interface NhlGame {
  gameState?: string;
  gameType?: number;
  gameDate?: string;
  startTimeUTC?: string;
  gameCenterLink?: string;
  venue?: { default?: string };
  homeTeam?: NhlTeam;
  awayTeam?: NhlTeam;
  periodDescriptor?: { periodType?: string };
}

/** "les Flyers de Philadelphie" */
function opponentName(t: NhlTeam): string | null {
  const common = t.commonName?.default;
  if (!common) return null;
  const prep = t.placeNameWithPreposition?.fr ?? (t.placeName?.default ? `de ${t.placeName.default}` : "");
  return `les ${common}${prep ? ` ${prep}` : ""}`;
}

function frWeekdayEvening(startSec: number): string {
  const day = new Date(startSec * 1000).toLocaleDateString("fr-CA", { weekday: "long", timeZone: "America/Toronto" });
  return `${day} soir`;
}

function relativeDay(startSec: number, nowSec: number): string {
  const tz = "America/Toronto";
  const fmt = (s: number) => new Date(s * 1000).toLocaleDateString("en-CA", { timeZone: tz });
  if (fmt(startSec) === fmt(nowSec)) return "ce soir";
  if (fmt(startSec) === fmt(nowSec + 86400)) return "demain soir";
  return frWeekdayEvening(startSec);
}

/**
 * Turn the season schedule into 0–2 fact candidates: the last finished Canadiens game (≤36 h ago)
 * and the next one (≤30 h ahead). Pure — unit-testable with a fixture.
 */
export function mtlGamesToFacts(games: NhlGame[], now: Date): TopicCandidate[] {
  const nowSec = Math.floor(now.getTime() / 1000);
  const out: TopicCandidate[] = [];
  const dated = games
    .filter((g) => g.startTimeUTC && (g.gameType === 2 || g.gameType === 3) && g.homeTeam && g.awayTeam)
    .map((g) => ({ g, start: Math.floor(Date.parse(g.startTimeUTC as string) / 1000) }))
    .filter((x) => Number.isFinite(x.start))
    .sort((a, b) => a.start - b.start);

  // Last finished game.
  const finished = dated.filter((x) => (x.g.gameState === "OFF" || x.g.gameState === "FINAL") && x.start <= nowSec);
  const last = finished[finished.length - 1];
  if (last && nowSec - last.start <= LAST_GAME_WINDOW_H * 3600) {
    const { g, start } = last;
    const mtlHome = g.homeTeam?.abbrev === "MTL";
    const mtl = mtlHome ? g.homeTeam : g.awayTeam;
    const opp = mtlHome ? g.awayTeam : g.homeTeam;
    const oppName = opp ? opponentName(opp) : null;
    if (mtl && opp && oppName && typeof mtl.score === "number" && typeof opp.score === "number") {
      const won = mtl.score > opp.score;
      const periodType = g.periodDescriptor?.periodType;
      const extra = periodType === "SO" ? " en tirs de barrage" : periodType === "OT" ? " en prolongation" : "";
      const verb = won ? "a gagné" : "a perdu";
      const title = `Le Canadien ${verb} ${mtl.score}-${opp.score} contre ${oppName} ${frWeekdayEvening(start)}${extra}`;
      out.push({
        title, source: "nhl-api", kind: "fact", published: start + GAME_LENGTH_SEC,
        url: g.gameCenterLink ? `https://www.nhl.com${g.gameCenterLink}` : undefined,
        context: [`Pointage final: Canadiens ${mtl.score}, ${oppName.replace(/^les /, "")} ${opp.score}${extra}.`, mtlHome ? "Match au Centre Bell." : "Match à l'extérieur."],
      });
    }
  }

  // Next game.
  const upcoming = dated.find((x) => x.g.gameState === "FUT" && x.start > nowSec);
  if (upcoming && upcoming.start - nowSec <= NEXT_GAME_WINDOW_H * 3600) {
    const { g, start } = upcoming;
    const mtlHome = g.homeTeam?.abbrev === "MTL";
    const opp = mtlHome ? g.awayTeam : g.homeTeam;
    const oppName = opp ? opponentName(opp) : null;
    if (oppName) {
      out.push({
        title: `Le Canadien affronte ${oppName} ${relativeDay(start, nowSec)}`,
        source: "nhl-api", kind: "fact", published: nowSec, expires: start,
        url: g.gameCenterLink ? `https://www.nhl.com${g.gameCenterLink}` : undefined,
        context: [mtlHome ? "Match au Centre Bell." : "Match à l'extérieur."],
      });
    }
  }
  return out;
}

export async function fetchMtlFacts(now: Date = new Date()): Promise<TopicCandidate[]> {
  const res = await fetch(SCHEDULE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { games?: NhlGame[] };
  return mtlGamesToFacts(Array.isArray(json.games) ? json.games : [], now);
}
