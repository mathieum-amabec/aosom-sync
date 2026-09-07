import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

/**
 * The SQL behind the /sequential-ads list, run against a real SQLite table.
 *
 * Worth executing rather than asserting as strings: the campaign filter goes through
 * `json_extract(metadata, '$.campaign')`, and a wrong path or a mismatched arg pair would
 * silently select everything (or nothing) while still looking correct in review. The old
 * behaviour — LIMIT 50 over 134 rows, filtered afterwards in the browser — is reproduced
 * here so the fix is measured against it rather than described.
 */

const CREATE = `CREATE TABLE publication_queue (
  id INTEGER PRIMARY KEY, content_type TEXT, content_id TEXT, platform TEXT,
  payload TEXT, scheduled_at TEXT, status TEXT, metadata TEXT, created_at TEXT
)`;

// Mirrors production on 2026-09-07, in NEWEST-FIRST order — which is the order the page
// returns, and the reason the bug bit automne rather than some other campaign. The five UGC
// campaigns were rendered automne → maison → enfants → animaux → hiver, so automne carries
// the OLDEST created_at of the batch and sorts last among the new ones: the 50-row cap fell
// exactly in its middle. Reorder this array and the regression test stops testing anything.
const PLAN: [string, number, string][] = [
  ["hiver-2026", 4, "ugc_video"],
  ["animaux-2026", 5, "ugc_video"],
  ["enfants-2026", 12, "ugc_video"],
  ["maison-2026", 11, "ugc_video"],
  ["automne-2026", 29, "ugc_video"],
  ["noel-2026", 8, "demand_gen_messages"],
  ["halloween-2026", 3, "demand_gen_messages"],
  ["patio-ete-2026", 62, "hero_slides"],
];

const CAP = 500;

describe("sequential-ad queue SQL", () => {
  let db: Client;

  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await db.execute(CREATE);
    let id = 1000;
    // created_at descends as we go, so the newest campaign sorts first — the real ordering.
    let day = 200;
    for (const [campaign, n, style] of PLAN) {
      for (let i = 0; i < n; i++) {
        await db.execute({
          sql: `INSERT INTO publication_queue VALUES (?,?,?,?,?,?,?,?,?)`,
          args: [
            id--, "sequential_ad", `seqad:${style}:${campaign}:S${i}`, "both",
            JSON.stringify({ reelsVideoUrl: "https://x/v.mp4" }),
            "2026-09-09 13:00:00", "draft",
            JSON.stringify({ style, campaign }),
            `2026-01-01 00:00:${String(day--).padStart(3, "0")}`,
          ],
        });
      }
    }
    // One cancelled row must never appear anywhere.
    await db.execute({
      sql: `INSERT INTO publication_queue VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [1, "sequential_ad", "seqad:x:automne-2026:X", "both", "{}", "2026-09-09 13:00:00",
             "cancelled", JSON.stringify({ style: "ugc_video", campaign: "automne-2026" }), "2026-01-01 00:00:000"],
    });
  });
  afterEach(() => db.close());

  /** The production query, verbatim in shape. */
  async function page(limit: number, campaign: string | null) {
    const filtered = !!campaign && campaign !== "all";
    const { rows } = await db.execute({
      sql: `SELECT * FROM publication_queue
            WHERE content_type = 'sequential_ad' AND status != 'cancelled'
              AND (? IS NULL OR json_extract(metadata, '$.campaign') = ?)
            ORDER BY created_at DESC, id DESC LIMIT ?`,
      args: [filtered ? campaign : null, filtered ? campaign : null, filtered ? CAP : limit],
    });
    return rows.map((r) => JSON.parse(String((r as unknown as Record<string, unknown>).metadata)).campaign as string);
  }

  const TOTAL = PLAN.reduce((s, [, n]) => s + n, 0);

  it("the fixture reproduces the production shape: 134 live rows", () => {
    expect(TOTAL).toBe(134);
  });

  it("OLD behaviour: a 50-row cap cut automne in half and hid three campaigns entirely", async () => {
    const got = await page(50, null);
    expect(got).toHaveLength(50);
    // hiver 4 + animaux 5 + enfants 12 + maison 11 = 32, leaving 18 of automne's 29.
    expect(got.filter((c) => c === "automne-2026")).toHaveLength(18);
    for (const hidden of ["noel-2026", "halloween-2026", "patio-ete-2026"]) {
      expect(got).not.toContain(hidden);
    }
  });

  it("NEW: the 200 cap carries every ugc_video ad and reaches the older campaigns", async () => {
    const got = await page(200, null);
    expect(got).toHaveLength(134);
    expect(got.filter((c) => c === "automne-2026")).toHaveLength(29);
    expect(got).toContain("noel-2026");
    expect(got).toContain("patio-ete-2026");
  });

  it("a campaign filter returns ALL of that campaign, past the unfiltered cap", async () => {
    for (const [campaign, n] of PLAN) {
      const got = await page(200, campaign);
      expect(got).toHaveLength(n);
      expect(new Set(got)).toEqual(new Set([campaign]));
    }
  });

  it("patio-ete-2026 (62 rows) comes back whole even though it sorts last", async () => {
    expect(await page(200, "patio-ete-2026")).toHaveLength(62);
  });

  it("never returns a cancelled row, filtered or not", async () => {
    const { rows } = await db.execute(
      `SELECT COUNT(*) n FROM publication_queue WHERE status='cancelled'`,
    );
    expect(Number((rows[0] as unknown as Record<string, unknown>).n)).toBe(1);
    expect(await page(200, null)).toHaveLength(134);
    expect(await page(200, "automne-2026")).toHaveLength(29);
  });

  it("an unknown campaign returns nothing rather than everything", async () => {
    expect(await page(200, "campagne-inexistante")).toHaveLength(0);
  });

  it("'all' is treated as no filter, not as a campaign literally named all", async () => {
    expect(await page(200, "all")).toHaveLength(134);
  });

  it("the campaign list covers every campaign, including those a page would cut off", async () => {
    const { rows } = await db.execute(
      `SELECT json_extract(metadata, '$.campaign') AS campaign, MAX(created_at) AS last_seen
       FROM publication_queue
       WHERE content_type = 'sequential_ad' AND status != 'cancelled'
         AND json_extract(metadata, '$.campaign') IS NOT NULL
       GROUP BY campaign ORDER BY last_seen DESC`,
    );
    const names = rows.map((r) => String((r as unknown as Record<string, unknown>).campaign));
    expect(names).toHaveLength(PLAN.length);
    expect(new Set(names)).toEqual(new Set(PLAN.map(([c]) => c)));
    // Newest activity first: hiver was the last campaign rendered.
    expect(names[0]).toBe("hiver-2026");
    expect(names[names.length - 1]).toBe("patio-ete-2026");
  });
});
