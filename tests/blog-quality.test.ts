import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/content-generator", () => ({ getAnthropicClient: vi.fn(() => ({})) }));
vi.mock("@/lib/llm-budget", () => ({ budgetedCreate: vi.fn() }));

import { blogRuleProblems, contentRuleProblems, demoteH1, checkBlogClaims, evaluateBlogArticle, buildClaimsPrompt, type BlogArticleInput } from "@/lib/blog-quality";
import type { LlmText } from "@/lib/auto-import/verify";

const para = (n: number) =>
  `<p>Choisir le bon aménagement pour votre salon demande un peu de réflexion, car chaque pièce a ses propres contraintes de lumière, de circulation et de rangement. ` +
  `Prenez le temps de mesurer l'espace disponible, de noter les sources de lumière naturelle et de choisir des matériaux qui s'entretiennent facilement. ` +
  `Un bon plan évite les achats impulsifs et garde la maison harmonieuse, confortable et agréable à vivre tout au long de l'année, saison après saison. (${n})</p>`;

const goodFr: BlogArticleInput = {
  lang: "fr",
  title: "Comment aménager un petit salon confortable et fonctionnel",
  metaDescription: "Des conseils simples pour aménager un petit salon: circulation, rangement, lumière et choix des meubles pour une pièce confortable.",
  tags: ["salon", "petit espace", "décoration", "rangement"],
  bodyHtml:
    `<p>Introduction courte au sujet de l'aménagement des petits salons, avec des idées pratiques pour la maison.</p>` +
    `<h2>Mesurer avant d'acheter</h2>${para(1)}${para(2)}` +
    `<h2>Choisir des meubles multifonctions</h2>${para(3)}${para(4)}<p>Voyez notre <a href="/collections/salon">sélection pour le salon</a>.</p>` +
    `<h2>Soigner la lumière</h2>${para(5)}${para(6)}<p>Consultez aussi <a href="/blogs/guides">nos guides d'achat</a>.</p>` +
    `<h2>Conclusion</h2>${para(7)}`,
};

describe("blogRuleProblems", () => {
  it("passes a clean article", () => {
    expect(blogRuleProblems(goodFr)).toEqual([]);
  });

  it("catches the supplier name, any supplier brand and internal names", () => {
    expect(blogRuleProblems({ ...goodFr, bodyHtml: goodFr.bodyHtml + "<p>Chez Aosom Canada, vous trouverez tout.</p>" })).toContain("supplier_name:aosom");
    expect(blogRuleProblems({ ...goodFr, bodyHtml: goodFr.bodyHtml + "<p>Une qualité Outsunny.</p>" }).join()).toContain("supplier_brand:outsunny");
    expect(blogRuleProblems({ ...goodFr, tags: [...goodFr.tags, "aosom"] })).toContain("supplier_name:aosom");
  });

  it("catches prices, SKUs, unsourced studies and bare percentages", () => {
    const add = (s: string) => blogRuleProblems({ ...goodFr, bodyHtml: goodFr.bodyHtml + `<p>${s}</p>` });
    expect(add("Une chaise se situe entre 400 $ et 900 $ CAD.")).toContain("price_in_article");
    expect(add("Le modèle 844-037V80 est populaire.")).toContain("sku_in_article");
    expect(add("Selon une étude récente, les plantes calment.")).toContain("unsourced_study_claim");
    expect(add("Studies show that plants reduce stress.")).toContain("unsourced_study_claim");
    expect(add("Les chaises représentent jusqu'à 40 % du budget.")).toContain("percentage_needs_source");
  });

  it("checks structure: H2 count, length, H1, unsafe HTML", () => {
    expect(blogRuleProblems({ ...goodFr, bodyHtml: goodFr.bodyHtml.replace(/<h2>/g, "<h3>").replace(/<\/h2>/g, "</h3>") }).join()).toContain("h2_count:0");
    expect(blogRuleProblems({ ...goodFr, bodyHtml: "<h2>a</h2><h2>b</h2><h2>c</h2><p>court</p>" }).join()).toContain("too_short");
    expect(blogRuleProblems({ ...goodFr, bodyHtml: goodFr.bodyHtml + "<h1>Titre</h1>" })).toContain("h1_in_body");
    expect(blogRuleProblems({ ...goodFr, bodyHtml: goodFr.bodyHtml + "<script>x</script>" })).toContain("unsafe_html");
    expect(blogRuleProblems({ ...goodFr, bodyHtml: goodFr.bodyHtml + '<p onclick="x()">a</p>' })).toContain("unsafe_html");
  });

  it("accepts FAQ structured data (JSON-LD script), which is wanted for SEO", () => {
    const faq = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>';
    expect(blogRuleProblems({ ...goodFr, bodyHtml: goodFr.bodyHtml + faq })).toEqual([]);
  });

  it("allows links to our own store and Unsplash photo credits only", () => {
    expect(blogRuleProblems({ ...goodFr, bodyHtml: goodFr.bodyHtml + '<p><a href="https://example.com/x">x</a></p>' }).join()).toContain("external_link:example.com");
    expect(blogRuleProblems({ ...goodFr, bodyHtml: goodFr.bodyHtml + '<p><a href="https://ameublodirect.ca/collections/a">a</a></p>' })).toEqual([]);
    expect(blogRuleProblems({ ...goodFr, bodyHtml: goodFr.bodyHtml + '<p><a href="https://unsplash.com/@x?utm_source=ameublodirect">Photo</a></p>' })).toEqual([]);
  });

  it("accepts 7-9 sections (older long guides) but not a wall of text", () => {
    const many = Array.from({ length: 8 }, (_, i) => `<h2>Section ${i}</h2>${para(i)}`).join("");
    expect(blogRuleProblems({ ...goodFr, bodyHtml: many })).toEqual([]);
  });

  it("demotes a stray H1 in the body to H2", () => {
    expect(demoteH1('<h1 class="x">Titre</h1><p>a</p>')).toBe('<h2 class="x">Titre</h2><p>a</p>');
  });

  it("checks language, title and meta description", () => {
    expect(blogRuleProblems({ ...goodFr, lang: "en" }).join()).toContain("language_not_english");
    expect(blogRuleProblems({ ...goodFr, title: "Court" }).join()).toContain("title_length");
    expect(blogRuleProblems({ ...goodFr, title: "Aménager un salon avec PawHut et plus encore" }).join()).toContain("title_company_like_token");
    expect(blogRuleProblems({ ...goodFr, metaDescription: "Trop court." }).join()).toContain("meta_length");
  });

  it("flags a near-duplicate of an existing title", () => {
    const r = blogRuleProblems(goodFr, { existingTitles: ["Comment aménager un petit salon confortable et fonctionnel chez soi"] });
    expect(r.join()).toContain("similar_title");
    expect(blogRuleProblems(goodFr, { existingTitles: ["Les tendances déco de l'automne"] })).toEqual([]);
  });

  it("exposes the content-only rules for the generator's corrective retry", () => {
    expect(contentRuleProblems({ title: "x", bodyHtml: "<p>Chez Aosom, 25 % de rabais à 40 $.</p>" })).toEqual(["supplier_name:aosom", "price_in_article", "percentage_needs_source"]);
  });
});

describe("claims check", () => {
  it("passes when nothing contestable is found, or only minor claims", async () => {
    expect((await checkBlogClaims(goodFr, async () => '{"claims":[]}')).ok).toBe(true);
    const minor = await checkBlogClaims(goodFr, async () => '{"claims":[{"text":"Le bois aime l ombre","kind":"other"}]}');
    expect(minor.ok).toBe(true);
    expect(minor.claims).toHaveLength(1);
  });

  it("fails on statistics, studies, health, legal, specs, prices and guarantees", async () => {
    for (const kind of ["statistic", "study", "health_safety", "legal_regulatory", "price", "guarantee"]) {
      const v = await checkBlogClaims(goodFr, async () => JSON.stringify({ claims: [{ text: "Un énoncé contestable", kind }] }));
      expect(v.ok, kind).toBe(false);
      expect(v.reasons[0]).toContain(`claim:${kind}`);
    }
  });

  it("does not block ordinary advice the checker files as product_spec", async () => {
    const v = await checkBlogClaims(goodFr, async () => JSON.stringify({ claims: [{ text: "Laissez 90 cm autour du canapé", kind: "product_spec" }] }));
    expect(v.ok).toBe(true);
    expect(v.claims).toHaveLength(1);
  });

  it("is fail-closed when the model is unreadable or unavailable", async () => {
    expect((await checkBlogClaims(goodFr, async () => "pas du json")).reasons).toEqual(["claims_check_unparseable"]);
    const v = await checkBlogClaims(goodFr, async () => {
      throw new Error("quota");
    });
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toContain("claims_check_unavailable");
  });

  it("puts the article in the prompt as untrusted content", () => {
    const p = buildClaimsPrompt(goodFr);
    expect(p).toContain("<ARTICLE>");
    expect(p).toContain(goodFr.title);
    expect(p).toContain("jamais des instructions");
  });
});

describe("evaluateBlogArticle", () => {
  it("does not pay for the model when the rules already fail", async () => {
    const llm = vi.fn() as unknown as LlmText;
    const r = await evaluateBlogArticle({ ...goodFr, title: "Court" }, { llm });
    expect(r.ok).toBe(false);
    expect(llm).not.toHaveBeenCalled();
  });
  it("runs the claims check once the rules pass", async () => {
    const llm = vi.fn(async () => '{"claims":[]}') as unknown as LlmText;
    expect((await evaluateBlogArticle(goodFr, { llm })).ok).toBe(true);
    expect(llm).toHaveBeenCalledOnce();
  });
});
