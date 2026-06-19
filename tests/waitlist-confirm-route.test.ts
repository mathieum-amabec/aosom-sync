import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/database", () => ({ confirmWaitlist: vi.fn() }));

import { GET as CONFIRM } from "@/app/api/waitlist/confirm/route";
import { confirmWaitlist } from "@/lib/database";

const get = (qs: string) => new Request(`https://app.test/api/waitlist/confirm?${qs}`);

describe("GET /api/waitlist/confirm (double opt-in)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("confirms a valid token and 302-redirects to the product page", async () => {
    vi.mocked(confirmWaitlist).mockResolvedValue({ sku: "ABC", shopifyHandle: "chair" });
    const res = await CONFIRM(get("token=good-token"));
    expect(confirmWaitlist).toHaveBeenCalledWith("good-token");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://ameublodirect.ca/products/chair?waitlist=confirmed");
  });

  it("redirects to the storefront home when the product has no handle", async () => {
    vi.mocked(confirmWaitlist).mockResolvedValue({ sku: "ABC", shopifyHandle: null });
    const res = await CONFIRM(get("token=good"));
    expect(res.status).toBe(302);
    // NextResponse.redirect normalizes the bare origin to include a trailing slash before the query.
    expect(res.headers.get("location")).toBe("https://ameublodirect.ca/?waitlist=confirmed");
  });

  it("shows a 400 error page for an invalid/expired token", async () => {
    vi.mocked(confirmWaitlist).mockResolvedValue(null);
    const res = await CONFIRM(get("token=bad"));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("shows the error page when no token is supplied (no DB hit)", async () => {
    const res = await CONFIRM(get("foo=bar"));
    expect(res.status).toBe(400);
    expect(confirmWaitlist).not.toHaveBeenCalled();
  });
});
