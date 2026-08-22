// Pinterest Tag storefront ScriptTag route: emits inert JS when PINTEREST_TAG_ID
// is unset or non-numeric (injection guard), and the real tag script (with the
// mirrored Meta event wiring) when a valid numeric id is set.
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ORIG = process.env.PINTEREST_TAG_ID;
afterEach(() => {
  if (ORIG === undefined) delete process.env.PINTEREST_TAG_ID;
  else process.env.PINTEREST_TAG_ID = ORIG;
});

async function getBody(): Promise<{ status: number; body: string; contentType: string | null }> {
  // Import fresh each call so the module-level `env` getter re-reads process.env.
  const mod = await import("@/app/api/pixel/pinterest-script/route");
  const res = await mod.GET();
  return { status: res.status, body: await res.text(), contentType: res.headers.get("Content-Type") };
}

describe("GET /api/pixel/pinterest-script", () => {
  beforeEach(() => delete process.env.PINTEREST_TAG_ID);

  it("returns an inert no-op script when PINTEREST_TAG_ID is unset", async () => {
    const { status, body, contentType } = await getBody();
    expect(status).toBe(200);
    expect(contentType).toContain("javascript");
    expect(body).toMatch(/not configured/i);
    expect(body).not.toContain("pintrk('load'");
  });

  it("rejects a non-numeric tag id (injection guard) → inert script", async () => {
    process.env.PINTEREST_TAG_ID = "abc'); alert(1);//";
    const { body } = await getBody();
    expect(body).toMatch(/not configured/i);
    expect(body).not.toContain("alert(1)");
  });

  it("emits the Pinterest tag + mirrored events for a valid numeric id", async () => {
    process.env.PINTEREST_TAG_ID = "2612345678901";
    const { body } = await getBody();
    expect(body).toContain("s.pinimg.com/ct/core.js");
    expect(body).toContain("pintrk('load', '2612345678901'");
    expect(body).toContain("pintrk('page')");
    // storefront events mirrored from the Meta script
    expect(body).toContain("'pagevisit'");
    expect(body).toContain("'viewcategory'");
    expect(body).toContain("'search'");
    expect(body).toContain("'addtocart'");
    // product_id = variant SKU (catalog g:id), and cart-add interception present
    expect(body).toContain("product_id");
    expect(body).toContain("/cart/add");
  });
});
