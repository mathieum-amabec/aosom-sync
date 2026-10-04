#!/usr/bin/env tsx
/**
 * scripts/mcp-server.mts — read-only MCP server for the aosom-sync catalogue (stdio).
 *
 * Claude Desktop / Claude Code spawn this process and talk JSON-RPC over stdin/stdout, so NOTHING
 * but protocol messages may be written to stdout (logs go to stderr).
 *
 *   node-x64 --env-file=<main clone>/.env.local node_modules/tsx/dist/cli.mjs scripts/mcp-server.mts
 *
 * Needs TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (or neither for the local SQLite file).
 * Tools: see src/lib/mcp/tools.ts — all read-only and row-capped (Turso bills per row read).
 */
import readline from "node:readline";
import path from "node:path";
import { createClient } from "@libsql/client";

async function main() {
  // tsx emits CJS for .mts, so named exports of an aliased module arrive on `default`.
  const mod = (await import("@/lib/mcp/protocol")) as unknown as { handleMessage?: typeof import("@/lib/mcp/protocol").handleMessage; default?: { handleMessage: typeof import("@/lib/mcp/protocol").handleMessage } };
  const handleMessage = (mod.handleMessage ?? mod.default?.handleMessage)!;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!!url !== !!authToken) {
    console.error("Both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (or neither for local SQLite)");
    process.exit(1);
  }
  const db = createClient(url && authToken ? { url, authToken } : { url: `file:${path.join(process.cwd(), "data", "aosom-sync.db")}` });

  const send = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
  const rl = readline.createInterface({ input: process.stdin });
  let pending = 0;
  let closed = false;
  const maybeExit = () => { if (closed && pending === 0) process.exit(0); };

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    pending++;
    handleMessage(db as never, msg)
      .then((res) => { if (res) send(res); })
      .catch((e) => send({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32603, message: String(e?.message ?? e) } }))
      .finally(() => { pending--; maybeExit(); });
  });
  rl.on("close", () => { closed = true; maybeExit(); });
  console.error("[aosom-sync mcp] ready (read-only)");
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
