#!/usr/bin/env node
/**
 * scripts/mcp-remote.mjs — stdio ↔ HTTP bridge so Claude Desktop can use the hosted aosom-sync
 * MCP endpoint. No dependencies: copy this single file anywhere and point Claude Desktop at it.
 *
 *   MCP_URL=https://<your-app>/api/mcp  MCP_KEY=amcp_…  node mcp-remote.mjs
 *
 * Create the key in the dashboard: Réglages → MCP. stdout carries protocol messages only.
 */
import readline from "node:readline";

const url = process.env.MCP_URL;
const key = process.env.MCP_KEY;
if (!url || !key) {
  console.error("MCP_URL and MCP_KEY are required");
  process.exit(1);
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const rl = readline.createInterface({ input: process.stdin });
let pending = 0;
let closed = false;
const maybeExit = () => { if (closed && pending === 0) process.exit(0); };

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  pending++;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: line,
    });
    if (res.status === 202) return; // notification accepted, no reply
    const text = await res.text();
    if (res.ok) { send(JSON.parse(text)); return; }
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `HTTP ${res.status}: ${text.slice(0, 200)}` } });
  } catch (e) {
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `Bridge error: ${e?.message ?? e}` } });
  } finally {
    pending--;
    maybeExit();
  }
});
rl.on("close", () => { closed = true; maybeExit(); });
