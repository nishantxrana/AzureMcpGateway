// REFERENCE ONLY - client-side checks used to verify gateway-spike.mjs (run it on port 8095 first).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
async function conn(alias, key) {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://localhost:8095/mcp/${alias}`), {
      requestInit: { headers: { "X-API-Key": key } },
    }),
  );
  return c;
}
let c = await conn("coolops", "key-coolops");
let { tools } = await c.listTools();
console.log("coolops tools:", tools.length, tools.map((t) => t.name).join(","));
console.log(
  "write tool visible?",
  tools.some((t) => /write|create_branch|upsert/.test(t.name)),
);
let r = await c.callTool({ name: "pipelines_write", arguments: {} });
console.log("blocked call ->", r.isError, r.content[0].text);
r = await c.callTool({ name: "core_list_projects", arguments: {} });
console.log(
  "allowed call forwarded ->",
  r.isError,
  r.content[0].text.slice(0, 150).replace(/\n/g, " "),
);
await c.close();
c = await conn("otherorg", "key-other");
({ tools } = await c.listTools());
console.log("otherorg tools:", tools.length, tools.map((t) => t.name).join(","));
await c.close();
// cross-org key misuse
try {
  await conn("otherorg", "key-coolops");
  console.log("cross-org key: ALLOWED (bad)");
} catch (e) {
  console.log("cross-org key rejected:", e.message.slice(0, 60));
}
