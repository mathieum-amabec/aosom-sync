import { describe, it, expect, beforeEach } from "vitest";
import {
  updateImportJob,
  upsertImportJob,
  getImportJob,
} from "@/lib/database";

describe("updateImportJob column allowlist", () => {
  const JOB_ID = "test-job-001";

  beforeEach(() => {
    // Seed a job so we have something to update
    upsertImportJob({
      id: JOB_ID,
      groupKey: "test-group",
      productData: "{}",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  it("allows updating valid column 'status'", () => {
    expect(() => updateImportJob(JOB_ID, { status: "generating" })).not.toThrow();
    const job = getImportJob(JOB_ID);
    expect(job?.status).toBe("generating");
  });

  it("allows updating valid column 'error'", () => {
    expect(() => updateImportJob(JOB_ID, { error: "timeout" })).not.toThrow();
  });

  it("allows updating multiple valid columns", () => {
    expect(() =>
      updateImportJob(JOB_ID, { status: "error", error: "API failed" })
    ).not.toThrow();
    const job = getImportJob(JOB_ID);
    expect(job?.status).toBe("error");
  });

  it("throws on unknown column name", () => {
    expect(() => updateImportJob(JOB_ID, { evil_col: "x" })).toThrow(
      "Invalid column name: evil_col"
    );
  });

  it("throws on SQL injection attempt in column name", () => {
    expect(() =>
      updateImportJob(JOB_ID, { "status; DROP TABLE import_jobs--": "x" })
    ).toThrow("Invalid column name");
  });

  it("throws on column name with spaces", () => {
    expect(() => updateImportJob(JOB_ID, { "status = 'hacked'--": "x" })).toThrow(
      "Invalid column name"
    );
  });

  it("does not throw on empty fields object", () => {
    expect(() => updateImportJob(JOB_ID, {})).not.toThrow();
  });

  it("updates updated_at automatically", () => {
    const before = getImportJob(JOB_ID);
    // Small delay to ensure different timestamp
    updateImportJob(JOB_ID, { status: "reviewing" });
    const after = getImportJob(JOB_ID);
    expect(after?.updated_at).not.toBe(before?.updated_at);
  });
});
