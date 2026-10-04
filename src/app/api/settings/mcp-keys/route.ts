import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { createMcpKey, listMcpKeys, revokeMcpKey } from "@/lib/database";
import { generateMcpKey, hashMcpKey, mcpKeyHint } from "@/lib/mcp/keys";

/** Admin-only management of the keys that unlock /api/mcp. The plaintext key is returned ONCE, at creation. */
export const dynamic = "force-dynamic";

const forbidden = () => NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });

export async function GET() {
  if (!(await isAdmin())) return forbidden();
  return NextResponse.json({ success: true, data: await listMcpKeys() });
}

export async function POST(request: Request) {
  if (!(await isAdmin())) return forbidden();
  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!name) return NextResponse.json({ success: false, error: "Un nom est requis" }, { status: 400 });
  const key = generateMcpKey();
  const id = await createMcpKey(name, hashMcpKey(key), mcpKeyHint(key));
  return NextResponse.json({ success: true, data: { id, name, key } });
}

export async function DELETE(request: Request) {
  if (!(await isAdmin())) return forbidden();
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ success: false, error: "id invalide" }, { status: 400 });
  const revoked = await revokeMcpKey(id);
  return NextResponse.json({ success: revoked, error: revoked ? undefined : "Clé introuvable ou déjà révoquée" }, { status: revoked ? 200 : 404 });
}
