/**
 * Permissions of an MCP connection. `read` is always granted; `analytics` and `import` are opt-in,
 * ticked by the admin on the OAuth consent page (claude.ai / mobile) or when creating a Desktop key.
 * Stored as a space-separated string on the grant / key.
 */
export type Scope = "read" | "analytics" | "import";

export const ALL_SCOPES: readonly Scope[] = ["read", "analytics", "import"];

export function parseScopes(raw: string | null | undefined): Set<Scope> {
  const out = new Set<Scope>(["read"]);
  for (const s of (raw ?? "").split(/\s+/)) if ((ALL_SCOPES as readonly string[]).includes(s)) out.add(s as Scope);
  return out;
}

export function formatScopes(scopes: Iterable<string>): string {
  const set = parseScopes([...scopes].join(" "));
  return ALL_SCOPES.filter((s) => set.has(s)).join(" ");
}

export const SCOPE_LABEL: Record<Scope, string> = {
  read: "Lecture",
  analytics: "Analytics",
  import: "Import",
};
