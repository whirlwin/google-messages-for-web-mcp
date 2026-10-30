#!/usr/bin/env bash
# Manual end-to-end check against your real, paired Messages for web tab.
# Not part of `npm test`. Reads always; sends only when GM_E2E_SEND_TEXT is set.
set -euo pipefail

: "${GM_E2E_CONVERSATION:?set GM_E2E_CONVERSATION to a conversation id}"
cd "$(dirname "$0")/.."
npm run build --silent

# Drives the built server over stdio via the MCP SDK client.
node --input-type=module - <<'JS'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};

const id = process.env.GM_E2E_CONVERSATION;
console.log("status:", JSON.stringify(await call("status")));
console.log("conversations:", (await call("list_conversations", { limit: 5 })).length);
console.log("messages:", (await call("read_messages", { conversation_id: id, limit: 5 })).messages.length);
if (process.env.GM_E2E_SEND_TEXT) {
  const r = await call("send_message", { conversation_id: id, text: process.env.GM_E2E_SEND_TEXT });
  console.log("sent:", r.sent);
}
await client.close();
JS
