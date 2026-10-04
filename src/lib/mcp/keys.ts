/**
 * MCP access keys: generated in the dashboard (Réglages → MCP), shown ONCE, stored only as a
 * SHA-256 hash. 32 random bytes → the key is unguessable, so a fast unsalted hash is enough
 * (no password-stretching needed) and lets the lookup be a plain indexed equality.
 */
import crypto from "node:crypto";

export const MCP_KEY_PREFIX = "amcp_";

export function generateMcpKey(): string {
  return MCP_KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
}

export function hashMcpKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/** First characters of the key, safe to display so an operator can tell keys apart. */
export function mcpKeyHint(key: string): string {
  return key.slice(0, MCP_KEY_PREFIX.length + 4);
}

/** `Authorization: Bearer amcp_…` → the key, or null. */
export function bearerKey(header: string | null): string | null {
  const m = header?.match(/^Bearer\s+(amcp_[A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : null;
}
