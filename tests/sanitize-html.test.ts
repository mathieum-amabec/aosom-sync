// CSO Finding 1: sanitizeHtml() now strips XSS vectors (script/style/iframe/on*=/
// javascript:) so Claude's generated HTML can't land runnable markup in Shopify
// body_html (rendered unescaped on the storefront). Applied to both input and output.
import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "@/lib/content-generator";

describe("sanitizeHtml — XSS strip (LLM output trust boundary)", () => {
  it("removes <script> blocks", () => {
    const out = sanitizeHtml("<p>Chaise</p><script>document.cookie</script>");
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/document\.cookie/);
    expect(out).toContain("Chaise");
  });

  it("removes on* event-handler attributes (quoted + unquoted)", () => {
    expect(sanitizeHtml('<img src="x" onerror="alert(1)">')).not.toMatch(/onerror/i);
    expect(sanitizeHtml("<div onclick=alert(1)>x</div>")).not.toMatch(/onclick/i);
  });

  it("removes javascript:/vbscript: URLs", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toMatch(/javascript:/i);
    expect(sanitizeHtml("<a href='vbscript:msgbox'>x</a>")).not.toMatch(/vbscript:/i);
  });

  it("removes iframe / style / object / embed elements", () => {
    const out = sanitizeHtml('<iframe src="//evil"></iframe><style>body{}</style><object></object>');
    expect(out).not.toMatch(/<iframe|<style|<object/i);
  });

  it("keeps benign product HTML intact", () => {
    const out = sanitizeHtml("<p>Chaise <strong>confortable</strong> et <em>solide</em>.</p>");
    expect(out).toContain("Chaise");
    expect(out).toContain("<strong>");
    expect(out).toContain("<em>");
  });
});
