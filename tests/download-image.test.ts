import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadImage, assertPublicHttpsUrl } from "@/lib/image-composer";

// Build a minimal fetch Response-like object.
function res(opts: { status: number; headers?: Record<string, string>; bytes?: number }) {
  const headers = new Headers(opts.headers || {});
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    headers,
    body: null,
    arrayBuffer: async () => new ArrayBuffer(opts.bytes ?? 8),
  } as unknown as Response;
}

describe("assertPublicHttpsUrl", () => {
  it("rejects non-HTTPS", () => {
    expect(() => assertPublicHttpsUrl(new URL("http://cdn.example.com/x.jpg"))).toThrow(/HTTPS/);
  });
  it("rejects internal/link-local hosts", () => {
    for (const h of ["https://127.0.0.1/x", "https://169.254.169.254/x", "https://10.0.0.5/x", "https://foo.internal/x"]) {
      expect(() => assertPublicHttpsUrl(new URL(h))).toThrow(/internal network/);
    }
  });
  it("allows a public HTTPS host", () => {
    expect(() => assertPublicHttpsUrl(new URL("https://cdn.example.com/x.jpg"))).not.toThrow();
  });
});

describe("downloadImage — SSRF + DoS hardening", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("downloads a public image", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(res({ status: 200, bytes: 16 }));
    const buf = await downloadImage("https://cdn.example.com/p.jpg");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.byteLength).toBe(16);
  });

  it("re-validates the host on a redirect hop and blocks internal targets", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      res({ status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } }),
    );
    await expect(downloadImage("https://cdn.example.com/p.jpg")).rejects.toThrow(/internal network/);
  });

  it("follows a redirect to another public host", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(res({ status: 301, headers: { location: "https://cdn2.example.com/p.jpg" } }))
      .mockResolvedValueOnce(res({ status: 200, bytes: 32 }));
    const buf = await downloadImage("https://cdn.example.com/p.jpg");
    expect(buf.byteLength).toBe(32);
  });

  it("rejects a redirect loop after the hop cap", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      res({ status: 302, headers: { location: "https://cdn.example.com/again.jpg" } }),
    );
    await expect(downloadImage("https://cdn.example.com/p.jpg")).rejects.toThrow(/Too many redirects/);
  });

  it("rejects an oversized image by Content-Length", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      res({ status: 200, headers: { "content-length": String(50 * 1024 * 1024) } }),
    );
    await expect(downloadImage("https://cdn.example.com/huge.jpg")).rejects.toThrow(/too large/i);
  });

  it("rejects a non-HTTPS source up front", async () => {
    await expect(downloadImage("http://cdn.example.com/p.jpg")).rejects.toThrow(/HTTPS/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
