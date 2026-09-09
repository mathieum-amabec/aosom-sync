/**
 * VERSION and package.json must agree.
 *
 * The repo carries the version twice: `VERSION` holds the 4-digit source of truth
 * (MAJOR.MINOR.PATCH.MICRO) and `package.json` holds the npm-valid 3-digit translation,
 * because npm rejects a fourth component. `/ship` writes both in one step through
 * `gstack-version-bump`, so the pair stays consistent whenever the release path is used.
 *
 * It drifted anyway. VERSION sat at 0.5.78.0 for five releases (v0.5.79.0 → v0.5.83.0) while
 * package.json and the CHANGELOG moved on, because those releases edited package.json by hand
 * instead of going through the bump tool. Nothing in the repo noticed: no CI job, no script and
 * no test reads VERSION, so the two files could disagree indefinitely.
 *
 * Fixing the bump tool would not have caught this — the tool was never called. The only check
 * that survives someone bypassing the release path is one that runs on the code itself, which
 * is what this is. `/ship` gates on a green suite before every PR, so a hand-edited version
 * now fails there instead of landing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const readVersionFile = () => readFileSync(join(root, "VERSION"), "utf8").trim();
const readPkgVersion = () =>
  (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version.trim();

/** The translation gstack-version-bump applies: the first three components, nothing else. */
const npmVersion = (v: string) => v.split(".").slice(0, 3).join(".");

describe("VERSION file", () => {
  it("is a 4-component version, the format the release path writes", () => {
    expect(readVersionFile()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it("carries no stray whitespace or newline that would break a string compare", () => {
    const raw = readFileSync(join(root, "VERSION"), "utf8");
    expect(raw.replace(/\r?\n$/, "")).toBe(raw.trim());
  });
});

describe("package.json version", () => {
  it("is valid 3-component npm semver — npm rejects a fourth", () => {
    expect(readPkgVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("the two stay in sync", () => {
  it("package.json is the 3-digit translation of VERSION", () => {
    const version = readVersionFile();
    const pkg = readPkgVersion();

    // The message matters more than the assertion here: whoever trips this is mid-release and
    // needs to know which file to move, not just that two strings differ.
    expect(
      pkg,
      `package.json (${pkg}) is not the npm translation of VERSION (${version}).\n` +
        `Expected package.json to be "${npmVersion(version)}".\n` +
        `Bump through the release path (/ship → gstack-version-bump write), which writes both, ` +
        `rather than editing package.json by hand.`,
    ).toBe(npmVersion(version));
  });

  it("does not regress to the drift that motivated this test", () => {
    // VERSION 0.5.78.0 with package.json 0.5.82 was the observed state across five releases.
    expect(npmVersion(readVersionFile())).not.toBe("0.5.78");
  });
});

describe("CHANGELOG agrees with VERSION", () => {
  it("the newest CHANGELOG heading is the current VERSION", () => {
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const firstHeading = changelog.match(/^## \[([0-9.]+)\]/m)?.[1];

    expect(
      firstHeading,
      `The top CHANGELOG entry is [${firstHeading}] but VERSION says ${readVersionFile()}. ` +
        `A release that writes one without the other is how the files drifted apart.`,
    ).toBe(readVersionFile());
  });
});
