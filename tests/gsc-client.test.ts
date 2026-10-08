import { describe, it, expect, vi, beforeEach } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { buildJwtAssertion, getAccessToken, listSites, queryAll, querySearchAnalytics, readGscConfig, resetGscTokenCache, type GscConfig } from "@/lib/gsc-client";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const cfg: GscConfig = { clientEmail: "aosom-sync-gsc@proj.iam.gserviceaccount.com", privateKey, siteUrl: "sc-domain:ameublodirect.ca" };
const keyJson = JSON.stringify({ client_email: cfg.clientEmail, private_key: privateKey });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => resetGscTokenCache());

describe("readGscConfig", () => {
  it("reports exactly what is missing", () => {
    expect(readGscConfig({})).toEqual({ configured: false, missing: ["GSC_SERVICE_ACCOUNT_JSON", "GSC_SITE_URL"] });
    expect(readGscConfig({ GSC_SITE_URL: "sc-domain:x.ca" })).toEqual({ configured: false, missing: ["GSC_SERVICE_ACCOUNT_JSON"] });
  });
  it("accepts the key as raw JSON or base64, and unescapes \\n in the private key", () => {
    const raw = readGscConfig({ GSC_SERVICE_ACCOUNT_JSON: keyJson, GSC_SITE_URL: "sc-domain:x.ca" });
    const b64 = readGscConfig({ GSC_SERVICE_ACCOUNT_JSON: Buffer.from(keyJson).toString("base64"), GSC_SITE_URL: "sc-domain:x.ca" });
    const escaped = readGscConfig({ GSC_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "a@b", private_key: "-----BEGIN-----\\nabc\\n-----END-----" }), GSC_SITE_URL: "s" });
    for (const r of [raw, b64]) expect(r).toMatchObject({ configured: true, config: { clientEmail: cfg.clientEmail, siteUrl: "sc-domain:x.ca" } });
    expect(escaped.configured && escaped.config.privateKey).toContain("\nabc\n");
  });
  it("flags an unreadable or incomplete key without throwing", () => {
    expect(readGscConfig({ GSC_SERVICE_ACCOUNT_JSON: "not json", GSC_SITE_URL: "s" })).toEqual({ configured: false, missing: ["GSC_SERVICE_ACCOUNT_JSON (illisible)"] });
    expect(readGscConfig({ GSC_SERVICE_ACCOUNT_JSON: "{}", GSC_SITE_URL: "s" }).configured).toBe(false);
  });
});

describe("buildJwtAssertion", () => {
  it("is a valid RS256 JWT for the read-only Search Console scope", () => {
    const jwt = buildJwtAssertion(cfg, 1_800_000_000);
    const [h, c, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claim = JSON.parse(Buffer.from(c, "base64url").toString());
    expect(claim).toMatchObject({ iss: cfg.clientEmail, scope: "https://www.googleapis.com/auth/webmasters.readonly", aud: "https://oauth2.googleapis.com/token", iat: 1_800_000_000, exp: 1_800_003_600 });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });
});

describe("getAccessToken", () => {
  it("exchanges the assertion once and caches the token", async () => {
    const f = vi.fn(async () => json({ access_token: "tok", expires_in: 3600 }));
    expect(await getAccessToken(cfg, f as unknown as typeof fetch)).toBe("tok");
    expect(await getAccessToken(cfg, f as unknown as typeof fetch)).toBe("tok");
    expect(f).toHaveBeenCalledOnce();
    const body = String((f.mock.calls[0] as unknown[])[1] && ((f.mock.calls[0] as unknown[])[1] as RequestInit).body);
    expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
  });
  it("surfaces Google's refusal readably", async () => {
    const f = vi.fn(async () => json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400));
    await expect(getAccessToken(cfg, f as unknown as typeof fetch)).rejects.toThrow(/invalid_grant/);
  });
});

function api(rowsByCall: Array<unknown>) {
  let i = 0;
  return vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes("oauth2.googleapis.com")) return json({ access_token: "tok", expires_in: 3600 });
    return json(rowsByCall[i++] ?? {});
  });
}

describe("Search Analytics", () => {
  it("posts the query for the property and returns the rows", async () => {
    const f = api([{ rows: [{ keys: ["2026-10-01", "https://ameublodirect.ca/"], clicks: 3, impressions: 40, ctr: 0.075, position: 8.2 }] }]);
    const rows = await querySearchAnalytics(cfg, { startDate: "2026-10-01", endDate: "2026-10-01", dimensions: ["date", "page"] }, f as unknown as typeof fetch);
    expect(rows).toHaveLength(1);
    const [url, init] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aameublodirect.ca/searchAnalytics/query");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toMatchObject({ startDate: "2026-10-01", dimensions: ["date", "page"], type: "web", dataState: "final", startRow: 0 });
  });

  it("follows startRow pagination until a short page", async () => {
    const full = Array.from({ length: 25000 }, (_, i) => ({ keys: ["d", `p${i}`], clicks: 1, impressions: 2, ctr: 0.5, position: 1 }));
    const f = api([{ rows: full }, { rows: full.slice(0, 10) }]);
    const rows = await queryAll(cfg, { startDate: "a", endDate: "b", dimensions: ["date", "page"] }, 100000, f as unknown as typeof fetch);
    expect(rows).toHaveLength(25010);
    const second = JSON.parse(String(((f.mock.calls[2] as unknown) as [string, RequestInit])[1].body));
    expect(second.startRow).toBe(25000);
  });

  it("explains an API refusal (e.g. the service account is not a user of the property)", async () => {
    const f = vi.fn(async (u: string | URL | Request) => (String(u).includes("oauth2") ? json({ access_token: "t", expires_in: 3600 }) : json({ error: { message: "User does not have sufficient permission" } }, 403)));
    await expect(querySearchAnalytics(cfg, { startDate: "a", endDate: "b", dimensions: ["date"] }, f as unknown as typeof fetch)).rejects.toThrow(/403/);
  });

  it("lists the properties the account can see", async () => {
    const f = api([{ siteEntry: [{ siteUrl: "sc-domain:ameublodirect.ca", permissionLevel: "siteRestrictedUser" }] }]);
    expect(await listSites(cfg, f as unknown as typeof fetch)).toEqual([{ siteUrl: "sc-domain:ameublodirect.ca", permissionLevel: "siteRestrictedUser" }]);
  });
});
