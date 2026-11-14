/**
 * GET /api/email/preview?flow=roue-1&locale=fr — the exact email a flow sends, filled with made-up
 * data (src/lib/email/samples.ts), as a web page. Session-protected (not in PUBLIC_PATHS).
 * `&format=text` shows the plain-text version.
 */
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSetting } from "@/lib/database";
import { ADDRESS_KEY, buildEmail } from "@/lib/email/engine";
import { FLOWS } from "@/lib/email/flows";
import { sampleProps } from "@/lib/email/samples";
import { esc } from "@/lib/email/layout";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const u = new URL(request.url);
  const flow = FLOWS.find((f) => f.key === u.searchParams.get("flow"));
  if (!flow) return NextResponse.json({ error: "flow", flows: FLOWS.map((f) => f.key) }, { status: 400 });
  const locale = u.searchParams.get("locale") === "en" ? "en" : "fr";
  const content = flow.render(sampleProps(flow.key, locale));
  if (!content) return NextResponse.json({ error: "sample-incomplete" }, { status: 500 });
  const address = ((await getSetting(ADDRESS_KEY)) ?? "").trim() || "[adresse postale à venir]";
  const email = buildEmail(
    { to: "exemple@exemple.ca", flow: flow.key, idemKey: "preview", kind: "marketing", locale, ...content },
    { from: process.env.EMAIL_FROM || "Ameublo Direct <bonjour@ameublodirect.ca>", replyTo: "", mailingAddress: address, tokenSecret: "x".repeat(32), baseUrl: u.origin },
  );
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
  if (u.searchParams.get("format") === "text") {
    return new NextResponse(`Objet : ${email.subject}\nAperçu : ${content.preheader}\n\n${email.text}`, { headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
  }
  // subject + preheader shown above the email, as an inbox would
  const banner = `<div style="font:13px/1.5 Arial,sans-serif;background:#222;color:#eee;padding:10px 16px"><b>Objet :</b> ${esc(email.subject)}<br><b>Aperçu :</b> ${esc(content.preheader)}</div>`;
  return new NextResponse(email.html.replace(/<body([^>]*)>/i, `<body$1>${banner}`), { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
}
