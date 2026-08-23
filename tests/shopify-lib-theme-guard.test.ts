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

type Theme = { id: string | number; name: string; role: "main" | "unpublished" };

const LIVE: Theme = { id: "161529233513", name: "DRAFT GOOGLE SHOPPING 2026-08-07", role: "main" };
const DRAFT: Theme = { id: "161562099817", name: "DRAFT DE TRAVAIL 2026-08-08", role: "unpublished" };
const BACKUP: Theme = { id: "161069989993", name: "DRAFT DE TRAVAIL 2026-07-18 v2", role: "unpublished" };

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
    LIVE_THEME_ID: string;
    DRAFT_THEME_ID: string;
    BACKUP_THEME_ID: string;
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

  it("guards the default target too — 41 of 63 call sites omit the theme", async () => {
    const lib = await load();
    // Default is BACKUP_THEME_ID; if a publish ever made that theme live, the omitted-argument
    // calls must fail rather than quietly edit production.
    withThemes([{ ...BACKUP, role: "main" }, DRAFT]);

    await expect(lib.putAsset("x", "y")).rejects.toThrow(/Refusing to write/);
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

describe("the exported constants still match the store", () => {
  it("LIVE/DRAFT/BACKUP are three distinct ids", async () => {
    const lib = await load();

    expect(new Set([lib.LIVE_THEME_ID, lib.DRAFT_THEME_ID, lib.BACKUP_THEME_ID]).size).toBe(3);
  });
});
