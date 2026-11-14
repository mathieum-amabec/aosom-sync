/**
 * Minimal MCP (Model Context Protocol) server core: JSON-RPC 2.0 over newline-delimited stdio,
 * tools only. Hand-rolled on purpose — the protocol surface we need is four methods, and it keeps
 * the SDK (and its dependency tree) out of the app's lockfile.
 */
import { TOOLS, type Db, type ToolDef } from "./tools";
import type { Scope } from "./scopes";

export const SERVER_INFO = { name: "aosom-sync", version: "0.1.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

interface RpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
export interface RpcResponse { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

const ok = (id: RpcRequest["id"], result: unknown): RpcResponse => ({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id: RpcRequest["id"], code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Handle one parsed message. Returns the response, or null for notifications (no reply). */
export async function handleMessage(
  db: Db,
  msg: RpcRequest,
  ctx: { scopes: ReadonlySet<Scope> } = { scopes: new Set<Scope>(["read"]) },
  allTools: ToolDef[] = TOOLS,
): Promise<RpcResponse | null> {
  // A connection only sees (and can only call) the tools its permissions allow.
  const tools = allTools.filter((t) => ctx.scopes.has(t.scope));
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : DEFAULT_PROTOCOL;
      return ok(msg.id, { protocolVersion: asked, capabilities: { tools: {} }, serverInfo: SERVER_INFO,
        instructions: "Ameublo Direct catalogue (Aosom + Costway): search and inventory (read), analytics and — only if granted — imports (always preview first, then confirm with the user)." });
    }
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const name = msg.params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(msg.id, -32602, `Unknown tool or permission not granted: ${String(name)}`);
      try {
        const data = await tool.handler(db, (msg.params?.arguments as Record<string, unknown>) ?? {});
        return ok(msg.id, { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] });
      } catch (e) {
        // Tool errors are reported in-band so the model can read and react to them.
        return ok(msg.id, { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] });
      }
    }
    default:
      if (isNotification || msg.method?.startsWith("notifications/")) return null;
      return fail(msg.id, -32601, `Method not found: ${String(msg.method)}`);
  }
}
