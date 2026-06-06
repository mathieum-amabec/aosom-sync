import { describe, it, expect } from "vitest";
import { triggerTypeClause, PRODUCT_TRIGGER_TYPES } from "@/lib/database";

describe("triggerTypeClause", () => {
  it("returns null for undefined (no filter — all drafts)", () => {
    expect(triggerTypeClause(undefined)).toBeNull();
  });

  it("returns null for empty string and 'all'", () => {
    expect(triggerTypeClause("")).toBeNull();
    expect(triggerTypeClause("all")).toBeNull();
  });

  it("returns null for null", () => {
    expect(triggerTypeClause(null)).toBeNull();
  });

  it("matches content_template exactly", () => {
    expect(triggerTypeClause("content_template")).toEqual({
      sql: "fd.trigger_type = ?",
      args: ["content_template"],
    });
  });

  it("expands 'products' to an IN clause over both product triggers", () => {
    const r = triggerTypeClause("products");
    expect(r).not.toBeNull();
    expect(r!.sql).toBe("fd.trigger_type IN (?, ?)");
    expect(r!.args).toEqual(["new_product", "stock_highlight"]);
    // placeholder count must match arg count (no SQL/arg mismatch)
    expect(r!.sql.split("?").length - 1).toBe(r!.args.length);
  });

  it("matches a specific product trigger exactly when not grouped", () => {
    expect(triggerTypeClause("new_product")).toEqual({
      sql: "fd.trigger_type = ?",
      args: ["new_product"],
    });
  });

  it("PRODUCT_TRIGGER_TYPES covers exactly the two auto-generated product triggers", () => {
    expect([...PRODUCT_TRIGGER_TYPES].sort()).toEqual(["new_product", "stock_highlight"]);
  });
});
