import { describe, it, expect, vi, beforeEach } from "vitest";

const auth = vi.hoisted(() => ({ authed: true, admin: true }));
vi.mock("@/lib/auth", () => ({
  isAuthenticated: vi.fn(async () => auth.authed),
  isAdmin: vi.fn(async () => auth.admin),
  getSession: vi.fn(async () => ({ username: "mat", role: "admin" })),
}));
const controls = vi.hoisted(() => ({ setAutomation: vi.fn(), getAutomationStatus: vi.fn() }));
vi.mock("@/lib/automation-controls", () => ({
  AUTOMATION_KEYS: ["auto_import", "publisher", "semaine"],
  setAutomation: controls.setAutomation,
  getAutomationStatus: controls.getAutomationStatus,
}));

import { GET, POST } from "@/app/api/automations/route";

const post = (body: unknown) =>
  POST(new Request("http://x/api/automations", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

beforeEach(() => {
  auth.authed = true;
  auth.admin = true;
  controls.setAutomation.mockReset();
  controls.getAutomationStatus.mockReset().mockResolvedValue({ ok: true });
});

describe("/api/automations", () => {
  it("requires a session, and admin rights", async () => {
    auth.authed = false;
    expect((await GET()).status).toBe(401);
    expect((await post({ key: "publisher", enabled: false })).status).toBe(401);
    auth.authed = true;
    auth.admin = false;
    expect((await GET()).status).toBe(403);
    expect((await post({ key: "publisher", enabled: false })).status).toBe(403);
    expect(controls.setAutomation).not.toHaveBeenCalled();
  });

  it("GET returns the status", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { ok: true } });
  });

  it("rejects bad input without changing anything", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ key: "nope", enabled: true })).status).toBe(400);
    expect((await post({ key: "publisher", enabled: "yes" })).status).toBe(400);
    expect((await post({ key: "auto_import", enabled: true, mode: "turbo" })).status).toBe(400);
    expect(controls.setAutomation).not.toHaveBeenCalled();
  });

  it("flips one switch, recording who did it", async () => {
    const res = await post({ key: "publisher", enabled: false });
    expect(res.status).toBe(200);
    expect(controls.setAutomation).toHaveBeenCalledOnce();
    expect(controls.setAutomation).toHaveBeenCalledWith("publisher", false, "mat", undefined);
  });

  it("passes the selected mode to the import only", async () => {
    await post({ key: "auto_import", enabled: true, mode: "pilot" });
    expect(controls.setAutomation).toHaveBeenCalledWith("auto_import", true, "mat", "pilot");
  });

  it("'all' flips the three switches together", async () => {
    await post({ key: "all", enabled: false });
    expect(controls.setAutomation.mock.calls.map((c) => c[0])).toEqual(["auto_import", "publisher", "semaine"]);
    expect(controls.setAutomation.mock.calls.every((c) => c[1] === false)).toBe(true);
  });
});
