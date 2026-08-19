import { describe, it, expect, vi } from "vitest";
import {
  PinterestClient,
  PinterestApiError,
  readPinterestCredentials,
  missingPinterestEnv,
  pinterestClientFromEnv,
  buildPinBody,
  composePinDescription,
  htmlToPinText,
  PIN_TITLE_MAX,
  PIN_DESCRIPTION_MAX,
  PIN_ALT_TEXT_MAX,
} from "@/lib/pinterest-client";

const CREDS = { accessToken: "tok", boardId: "board-1" };
const PIN = {
  title: "Chaise de patio pliante",
  description: "Confort et rangement facile.",
  link: "https://ameublodirect.ca/products/chaise",
  imageUrl: "https://cdn.example.com/chaise.jpg",
};

describe("readPinterestCredentials", () => {
  it("reads both vars", () => {
    expect(readPinterestCredentials({ PINTEREST_ACCESS_TOKEN: "a", PINTEREST_BOARD_ID: "b" }))
      .toEqual({ accessToken: "a", boardId: "b" });
  });

  it("returns null when the board is missing — a Pin cannot be created without one", () => {
    expect(readPinterestCredentials({ PINTEREST_ACCESS_TOKEN: "a" })).toBeNull();
  });

  it("returns null when the token is missing", () => {
    expect(readPinterestCredentials({ PINTEREST_BOARD_ID: "b" })).toBeNull();
  });

  it("IGNORES PINTEREST_TAG_ID — it is the storefront conversion tag, not a credential", () => {
    expect(readPinterestCredentials({ PINTEREST_TAG_ID: "2613172292580" })).toBeNull();
    expect(missingPinterestEnv({ PINTEREST_TAG_ID: "2613172292580" }))
      .toEqual(["PINTEREST_ACCESS_TOKEN", "PINTEREST_BOARD_ID"]);
  });
});

describe("buildPinBody", () => {
  it("maps to the v5 shape with an image_url media source", () => {
    expect(buildPinBody(PIN, "board-9")).toEqual({
      board_id: "board-9",
      title: PIN.title,
      description: PIN.description,
      link: PIN.link,
      media_source: { source_type: "image_url", url: PIN.imageUrl },
    });
  });

  it("omits alt_text when not supplied rather than sending an empty string", () => {
    expect(buildPinBody(PIN, "b")).not.toHaveProperty("alt_text");
    expect(buildPinBody({ ...PIN, altText: "Chaise grise" }, "b").alt_text).toBe("Chaise grise");
  });

  it("truncates over-long fields instead of throwing, so one long caption cannot fail a queue item", () => {
    const body = buildPinBody(
      { ...PIN, title: "T".repeat(200), description: "D".repeat(1200), altText: "A".repeat(900) },
      "b",
    );
    expect((body.title as string).length).toBe(PIN_TITLE_MAX);
    expect((body.description as string).length).toBe(PIN_DESCRIPTION_MAX);
    expect((body.alt_text as string).length).toBe(PIN_ALT_TEXT_MAX);
    expect(body.title as string).toMatch(/…$/);
  });

  it("leaves a field exactly at the limit untouched", () => {
    const body = buildPinBody({ ...PIN, title: "T".repeat(PIN_TITLE_MAX) }, "b");
    expect(body.title).toBe("T".repeat(PIN_TITLE_MAX));
    expect(body.title as string).not.toMatch(/…$/);
  });
});

describe("composePinDescription", () => {
  it("appends price and brand as separate paragraphs", () => {
    expect(composePinDescription({ caption: "Parfait pour le patio.", priceCad: 149.99, brand: "Ameublo Direct" }))
      .toBe("Parfait pour le patio.\n\n149.99 $ CAD · Livraison gratuite au Canada\n\nAmeublo Direct");
  });

  it("omits the price line when the price is absent or not finite", () => {
    expect(composePinDescription({ caption: "Texte" })).toBe("Texte");
    expect(composePinDescription({ caption: "Texte", priceCad: Number.NaN })).toBe("Texte");
    expect(composePinDescription({ caption: "Texte", priceCad: null })).toBe("Texte");
  });
});

describe("htmlToPinText", () => {
  it("turns an Aosom <ul> into bullet lines — Pinterest renders plain text, tags would show literally", () => {
    const html =
      '<ul style="list-style:disc"><li>Holds 24&ndash;32 pairs</li><li>Slim 9.3&quot; depth</li></ul>';
    expect(htmlToPinText(html)).toBe('• Holds 24–32 pairs\n• Slim 9.3" depth');
  });

  it("decodes entities so shoppers never see &amp; or &ndash;", () => {
    expect(htmlToPinText("Tables &amp; chaises &ndash; 2 pieces")).toBe("Tables & chaises – 2 pieces");
  });

  it("is a no-op on text that is already plain", () => {
    expect(htmlToPinText("Parfait pour le patio.")).toBe("Parfait pour le patio.");
  });

  it("collapses runaway whitespace and blank lines", () => {
    expect(htmlToPinText("<p>a</p>\n\n\n<p>b</p>")).toBe("a\nb");
  });

  it("is applied by composePinDescription, so a raw Aosom description never ships as HTML", () => {
    const out = composePinDescription({ caption: "<ul><li>Point A</li></ul>", priceCad: 99.99 });
    expect(out).not.toMatch(/<[a-z]/i);
    expect(out).toBe("• Point A\n\n99.99 $ CAD · Livraison gratuite au Canada");
  });
});

describe("PinterestClient — dry run", () => {
  it("sends nothing and records the payload", async () => {
    const fetchImpl = vi.fn();
    const c = new PinterestClient(null, { dryRun: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await c.createPin(PIN);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.pinId).toBe("dryrun-pin-1");
    expect(c.plan).toHaveLength(1);
    expect(c.plan[0].body).toMatchObject({ board_id: "DRYRUN_BOARD", link: PIN.link });
  });

  it("numbers synthetic ids so a multi-Pin plan stays readable", async () => {
    const c = new PinterestClient(null, { dryRun: true });
    expect((await c.createPin(PIN)).pinId).toBe("dryrun-pin-1");
    expect((await c.createPin(PIN)).pinId).toBe("dryrun-pin-2");
  });
});

describe("PinterestClient — live", () => {
  it("POSTs to /v5/pins with a Bearer token", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ id: "pin-42" }), { status: 200 }));
    const c = new PinterestClient(CREDS, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await c.createPin(PIN);
    expect(res).toEqual({ pinId: "pin-42", url: "https://www.pinterest.com/pin/pin-42/" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.pinterest.com/v5/pins");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string).board_id).toBe("board-1");
  });

  it("flattens the error envelope", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: 2, message: "Authentication failed." }), { status: 401 }));
    const c = new PinterestClient(CREDS, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(c.createPin(PIN)).rejects.toThrow(PinterestApiError);
    await expect(c.createPin(PIN)).rejects.toThrow(/HTTP 401[\s\S]*2: Authentication failed\./);
  });

  it("throws when the API answers 200 without an id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const c = new PinterestClient(CREDS, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(c.createPin(PIN)).rejects.toThrow(/returned no id/);
  });

  it("retries a 429 then succeeds", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      return n === 1
        ? new Response("{}", { status: 429, headers: { "Retry-After": "0" } })
        : new Response(JSON.stringify({ id: "pin-7" }), { status: 200 });
    });
    const c = new PinterestClient(CREDS, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await c.createPin(PIN)).pinId).toBe("pin-7");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses to construct without credentials unless dryRun is set", () => {
    expect(() => new PinterestClient(null)).toThrow(/credentials are required/);
    expect(() => new PinterestClient(null)).toThrow(/PINTEREST_TAG_ID/);
  });
});

describe("pinterestClientFromEnv", () => {
  it("degrades to dry-run when credentials are absent", () => {
    expect(pinterestClientFromEnv({}).dryRun).toBe(true);
    expect(pinterestClientFromEnv({ PINTEREST_TAG_ID: "123" }).dryRun).toBe(true);
  });

  it("goes live when both vars are present", () => {
    const c = pinterestClientFromEnv({ PINTEREST_ACCESS_TOKEN: "a", PINTEREST_BOARD_ID: "b" });
    expect(c.dryRun).toBe(false);
    expect(c.boardId).toBe("b");
  });
});
