import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import sharp from "sharp";
import { buildRetouchPrompt, retouchImage, RetouchError, PRESETS } from "@/lib/studio/ai-retouch";

describe("buildRetouchPrompt", () => {
  it("keeps the product-must-stay-identical guardrail on every preset that shows the product", () => {
    for (const p of PRESETS.filter((x) => x.id !== "empty_room")) {
      const prompt = buildRetouchPrompt({ preset: p.id, instruction: "fond plus clair" });
      expect(prompt, p.id).toMatch(/must stay exactly identical/);
      expect(prompt, p.id).toMatch(/Do not add any text, logo, watermark/);
    }
  });
  it("empty_room removes the product but keeps the room", () => {
    expect(buildRetouchPrompt({ preset: "empty_room" })).toMatch(/Remove the main piece of furniture/);
  });
  it("uses the chosen scene and season", () => {
    expect(buildRetouchPrompt({ preset: "stage", scene: "patio" })).toContain("backyard patio");
    expect(buildRetouchPrompt({ preset: "season", season: "noel" })).toContain("Christmas");
  });
  it("free preset needs an instruction", () => {
    expect(buildRetouchPrompt({ preset: "free", instruction: "  " })).toBeNull();
    expect(buildRetouchPrompt({ preset: "free", instruction: "salon scandinave" })).toContain("salon scandinave");
  });
});

describe("retouchImage", () => {
  let jpeg: Buffer;
  beforeEach(async () => {
    jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#c33" } }).jpeg().toBuffer();
    process.env.AI_GATEWAY_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_GATEWAY_API_KEY;
  });

  it("sends the image inline with image output enabled and decodes the returned data URI", async () => {
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#3c3" } }).png().toBuffer();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }] } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await retouchImage(jpeg, "prompt");
    expect((await sharp(out).metadata()).format).toBe("jpeg");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    const body = JSON.parse(init.body);
    expect(body.modalities).toEqual(["image", "text"]);
    expect(body.messages[0].content[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(init.headers.Authorization).toBe("Bearer test-key");
  });

  it("explains an exhausted credit balance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no credits", { status: 402 })));
    await expect(retouchImage(jpeg, "p")).rejects.toThrow(/crédit AI Gateway épuisé/);
  });

  it("fails clearly when the model answers without an image", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "je ne peux pas" } }] }), { status: 200 })));
    await expect(retouchImage(jpeg, "p")).rejects.toThrow(/pas renvoyé d'image/);
  });

  it("refuses (503) when AI Gateway isn't configured", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    const prevOidc = process.env.VERCEL_OIDC_TOKEN;
    delete process.env.VERCEL_OIDC_TOKEN;
    await expect(retouchImage(jpeg, "p")).rejects.toMatchObject({ status: 503 });
    await expect(retouchImage(jpeg, "p")).rejects.toBeInstanceOf(RetouchError);
    if (prevOidc) process.env.VERCEL_OIDC_TOKEN = prevOidc;
  });
});
