/**
 * The write guard in `scripts/_shopify-lib.mjs`.
 *
 * 38 of the ops scripts write theme assets; 19 carried a hand-rolled "is this theme
 * unpublished?" check and 19 did not, and `putAsset`'s default target was BACKUP_THEME_ID —
 * so a call that simply omitted the theme wrote to the rollback theme. The guard now lives
 * once, inside putAsset, and asks Shopify for the role rather than trusting the constants,
 * because a constant that drifted since the last publish protects the wrong theme.
 *
 * These are the first tests over scripts/: worth it, because this is the only code in the
 * repo whose failure mode is "silently edits the storefront".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

type Theme = { id: string | number; name: string; role: "main" | "unpublished"; updated_at?: string };

const LIVE: Theme = { id: "161529233513", name: "DRAFT GOOGLE SHOPPING 2026-08-07", role: "main", updated_at: "2026-08-30T10:00:00Z" };
const DRAFT: Theme = { id: "161562099817", name: "DRAFT DE TRAVAIL 2026-08-08", role: "unpublished", updated_at: "2026-08-29T10:00:00Z" };
const BACKUP: Theme = { id: "161069989993", name: "DRAFT DE TRAVAIL 2026-07-18 v2", role: "unpublished", updated_at: "2026-07-18T10:00:00Z" };

function ok(body: unknown) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}
function fail(status: number, text = "nope") {
  return { ok: false, status, headers: { get: () => null }, json: async () => ({}), text: async () => text };
}

/** themes.json first, then whatever the write returns. */
function withThemes(themes: Theme[], ...rest: unknown[]) {
  mockFetch.mockResolvedValueOnce(ok({ themes }));
  for (const r of rest) mockFetch.mockResolvedValueOnce(r);
}

/** Fresh module each test — themeRoles() memoises per process. */
async function load() {
  vi.resetModules();
  return import("../scripts/_shopify-lib.mjs") as Promise<{
    putAsset: (k: string, v: string, id?: string) => Promise<unknown>;
    putAssetToPublishedTheme: (k: string, v: string, id: string) => Promise<unknown>;
    assertWritableTheme: (id: string) => Promise<void>;
    themeRoles: () => Promise<Map<string, { role: string; name: string }>>;
    getLiveThemeId: () => Promise<string>;
    getDraftThemeId: (opts?: { themeId?: string }) => Promise<string>;
    getBackupThemeId: (opts?: { themeId?: string }) => Promise<string>;
    listThemes: () => Promise<Array<{ id: string; name: string; role: string; updated_at?: string }>>;
  }>;
}

const writeCalls = () =>
  mockFetch.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === "PUT");

beforeEach(() => {
  mockFetch.mockReset();
  process.env.SHOPIFY_ACCESS_TOKEN = "test-token";
});

describe("importing the module", () => {
  it("does not need .env.local just to be imported", async () => {
    // The token used to be read at module load, so importing the library anywhere without an
    // .env.local threw before a single call was made.
    await expect(load()).resolves.toBeDefined();
  });
});

describe("putAsset refuses the published theme", () => {
  it("throws instead of writing when the target is the live theme", async () => {
    const lib = await load();
    withThemes([LIVE, DRAFT]);

    await expect(lib.putAsset("templates/index.json", "{}", String(LIVE.id))).rejects.toThrow(
      /Refusing to write to theme .* role is "main"/,
    );
    expect(writeCalls()).toHaveLength(0);
  });

  it("names the theme in the error, since the names are misleading", async () => {
    // The live theme is literally called "DRAFT GOOGLE SHOPPING 2026-08-07" — an operator
    // reading only an id would not realise what they nearly edited.
    const lib = await load();
    withThemes([LIVE, DRAFT]);

    await expect(lib.putAsset("x", "y", String(LIVE.id))).rejects.toThrow(/DRAFT GOOGLE SHOPPING 2026-08-07/);
  });

  it("throws on an id the store does not have — the stale-constant case", async () => {
    const lib = await load();
    withThemes([LIVE, DRAFT]);

    await expect(lib.putAsset("x", "y", "160213696617")).rejects.toThrow(/does not exist/);
    expect(writeCalls()).toHaveLength(0);
  });

  it("writes when the target really is unpublished", async () => {
    const lib = await load();
    withThemes([LIVE, DRAFT], ok({ asset: { key: "x" } }));

    await expect(lib.putAsset("x", "y", String(DRAFT.id))).resolves.toEqual({ asset: { key: "x" } });
    expect(writeCalls()).toHaveLength(1);
    expect(String(writeCalls()[0][0])).toContain(`/themes/${DRAFT.id}/assets.json`);
  });

  it("resolves the default target instead of trusting a constant — 41 of 63 call sites omit the theme", async () => {
    const lib = await load();
    // The default used to be the BACKUP_THEME_ID constant, so a publish that promoted that
    // theme turned every omitted-argument call into a production edit. The default is now
    // whatever themes.json calls the newest unpublished theme, so it cannot be the live one.
    withThemes([{ ...BACKUP, role: "main" }, DRAFT], ok({ asset: { key: "x" } }));

    await expect(lib.putAsset("x", "y")).resolves.toBeTruthy();
    const [url] = writeCalls()[0] as [string];
    expect(url).toContain(`/themes/${DRAFT.id}/assets.json`);
    expect(url).not.toContain(String(BACKUP.id));
  });

  it("still refuses when the only unpublished candidate is gone — no silent fallback to live", async () => {
    const lib = await load();
    withThemes([LIVE]); // nothing but the published theme

    await expect(lib.putAsset("x", "y")).rejects.toThrow(/no unpublished theme/);
    expect(writeCalls()).toHaveLength(0);
  });

  it("surfaces the write's own HTTP failure once the guard has passed", async () => {
    const lib = await load();
    withThemes([LIVE, DRAFT], fail(422, "asset invalid"));

    await expect(lib.putAsset("x", "y", String(DRAFT.id))).rejects.toThrow(/putAsset x failed: 422 .*asset invalid/);
  });
});

describe("putAssetToPublishedTheme — the deliberate exception", () => {
  it("writes when the target is genuinely the published theme", async () => {
    const lib = await load();
    withThemes([LIVE, DRAFT], ok({ asset: { key: "x" } }));

    await expect(lib.putAssetToPublishedTheme("x", "y", String(LIVE.id))).resolves.toBeDefined();
    expect(writeCalls()).toHaveLength(1);
  });

  it("refuses an unpublished target, so a live-fix script cannot edit a dead theme by mistake", async () => {
    // This is the failure the live-targeting scripts actually had: pointed at a June theme
    // they believed was live, they would have "fixed production" somewhere nobody looks.
    const lib = await load();
    withThemes([LIVE, DRAFT]);

    await expect(lib.putAssetToPublishedTheme("x", "y", String(DRAFT.id))).rejects.toThrow(
      /has role "unpublished", not "main"/,
    );
    expect(writeCalls()).toHaveLength(0);
  });
});

describe("themeRoles caching", () => {
  it("asks Shopify once per process, not once per write", async () => {
    const lib = await load();
    withThemes([LIVE, DRAFT], ok({ asset: {} }), ok({ asset: {} }));

    await lib.putAsset("a", "1", String(DRAFT.id));
    await lib.putAsset("b", "2", String(DRAFT.id));

    expect(mockFetch.mock.calls.filter((c) => String(c[0]).includes("/themes.json"))).toHaveLength(1);
    expect(writeCalls()).toHaveLength(2);
  });

  it("does not cache a failure — a transient blip must not poison the rest of the run", async () => {
    const lib = await load();
    mockFetch.mockResolvedValueOnce(fail(503, "upstream"));
    await expect(lib.assertWritableTheme(String(DRAFT.id))).rejects.toThrow(/themes.json failed: 503/);

    mockFetch.mockResolvedValueOnce(ok({ themes: [LIVE, DRAFT] }));
    await expect(lib.assertWritableTheme(String(DRAFT.id))).resolves.toBeUndefined();
  });
});

describe("getLiveThemeId — the id is resolved, never hardcoded", () => {
  it("returns the id of the single theme whose role is main", async () => {
    const lib = await load();
    mockFetch.mockResolvedValueOnce(ok({ themes: [DRAFT, LIVE, BACKUP] }));

    await expect(lib.getLiveThemeId()).resolves.toBe(String(LIVE.id));
  });

  it("throws when NO theme is main — refusing to call something else live", async () => {
    const lib = await load();
    mockFetch.mockResolvedValueOnce(ok({ themes: [DRAFT, BACKUP] }));

    await expect(lib.getLiveThemeId()).rejects.toThrow(/no theme has role "main"/);
  });

  it("lists every theme when none is main, so the operator can see what came back", async () => {
    const lib = await load();
    mockFetch.mockResolvedValueOnce(ok({ themes: [DRAFT, BACKUP] }));

    await expect(lib.getLiveThemeId()).rejects.toThrow(String(DRAFT.id));
  });

  it("throws when MORE THAN ONE theme claims main, instead of picking one", async () => {
    const lib = await load();
    const alsoMain: Theme = { id: "999", name: "impossible", role: "main", updated_at: "2026-09-01T00:00:00Z" };
    mockFetch.mockResolvedValueOnce(ok({ themes: [LIVE, alsoMain, DRAFT] }));

    await expect(lib.getLiveThemeId()).rejects.toThrow(/2 themes claim role "main"/);
  });

  it("names both offenders when two claim main", async () => {
    const lib = await load();
    const alsoMain: Theme = { id: "999", name: "impossible", role: "main", updated_at: "2026-09-01T00:00:00Z" };
    mockFetch.mockResolvedValueOnce(ok({ themes: [LIVE, alsoMain] }));

    await expect(lib.getLiveThemeId()).rejects.toThrow(/999/);
  });

  it("never returns an unpublished id — the whole point of the guard", async () => {
    const lib = await load();
    mockFetch.mockResolvedValueOnce(ok({ themes: [DRAFT, LIVE, BACKUP] }));

    const id = await lib.getLiveThemeId();
    expect(id).not.toBe(String(DRAFT.id));
    expect(id).not.toBe(String(BACKUP.id));
  });
});

describe("getDraftThemeId / getBackupThemeId — recency, and no guessing when tied", () => {
  it("DRAFT is the most recently updated unpublished theme", async () => {
    const lib = await load();
    mockFetch.mockResolvedValueOnce(ok({ themes: [BACKUP, LIVE, DRAFT] }));

    await expect(lib.getDraftThemeId()).resolves.toBe(String(DRAFT.id));
  });

  it("BACKUP is the second most recent, giving a real two-step rollback ladder", async () => {
    const lib = await load();
    mockFetch.mockResolvedValueOnce(ok({ themes: [BACKUP, LIVE, DRAFT] }));

    await expect(lib.getBackupThemeId()).resolves.toBe(String(BACKUP.id));
  });

  it("never hands back the live theme as a write target", async () => {
    const lib = await load();
    mockFetch.mockResolvedValueOnce(ok({ themes: [BACKUP, LIVE, DRAFT] }));

    await expect(lib.getDraftThemeId()).resolves.not.toBe(String(LIVE.id));
  });

  it("throws rather than coin-flip when the two newest drafts share updated_at", async () => {
    const lib = await load();
    const tie: Theme = { ...DRAFT, id: "777", name: "tie", updated_at: DRAFT.updated_at };
    mockFetch.mockResolvedValueOnce(ok({ themes: [LIVE, DRAFT, tie] }));

    await expect(lib.getDraftThemeId()).rejects.toThrow(/cannot tell DRAFT apart/);
  });

  it("accepts an explicit themeId once the operator has read the list", async () => {
    const lib = await load();
    const tie: Theme = { ...DRAFT, id: "777", name: "tie", updated_at: DRAFT.updated_at };
    mockFetch.mockResolvedValueOnce(ok({ themes: [LIVE, DRAFT, tie] }));

    await expect(lib.getDraftThemeId({ themeId: "777" })).resolves.toBe("777");
  });

  it("rejects an explicit themeId that is the live theme", async () => {
    const lib = await load();
    mockFetch.mockResolvedValueOnce(ok({ themes: [LIVE, DRAFT, BACKUP] }));

    await expect(lib.getDraftThemeId({ themeId: String(LIVE.id) })).rejects.toThrow(/not an unpublished theme/);
  });

  it("throws when there is no unpublished theme at all", async () => {
    const lib = await load();
    mockFetch.mockResolvedValueOnce(ok({ themes: [LIVE] }));

    await expect(lib.getDraftThemeId()).rejects.toThrow(/no unpublished theme/);
  });

  it("refuses an ambiguous BACKUP — old drafts routinely share a timestamp", async () => {
    const lib = await load();
    const tied: Theme = { ...BACKUP, id: "888", name: "also stale", updated_at: BACKUP.updated_at };
    mockFetch.mockResolvedValueOnce(ok({ themes: [LIVE, DRAFT, BACKUP, tied] }));

    await expect(lib.getBackupThemeId()).rejects.toThrow(/rollback point is ambiguous/);
  });
});
