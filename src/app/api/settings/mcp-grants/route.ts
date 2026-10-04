import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { listOAuthGrants, revokeOAuthGrant } from "@/lib/database";

/** Admin-only: connections approved through the OAuth consent page (claude.ai / mobile). */
export const dynamic = "force-dynamic";

const forbidden = () => NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });

export async function GET() {
  if (!(await isAdmin())) return forbidden();
  return NextResponse.json({ success: true, data: await listOAuthGrants() });
}

export async function DELETE(request: Request) {
  if (!(await isAdmin())) return forbidden();
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ success: false, error: "id invalide" }, { status: 400 });
  const revoked = await revokeOAuthGrant(id);
  return NextResponse.json({ success: revoked, error: revoked ? undefined : "Connexion introuvable ou déjà révoquée" }, { status: revoked ? 200 : 404 });
}
