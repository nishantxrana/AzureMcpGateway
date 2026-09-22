// Usage:
//   node scripts/test-client.mjs <mcp-url> <api-key>                      -> list tools
//   node scripts/test-client.mjs <mcp-url> <api-key> <tool> '<json-args>' -> call a tool
// Examples:
//   node scripts/test-client.mjs https://myapp.azurewebsites.net/mcp KEY
//   node scripts/test-client.mjs https://myapp.azurewebsites.net/mcp KEY core_list_projects '{}'
//   node scripts/test-client.mjs https://myapp.azurewebsites.net/mcp KEY get_pr_context '{"prId":456}'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url, key, tool, argsJson] = process.argv.slice(2);
if (!url || !key) {
  console.error("Usage: node scripts/test-client.mjs <mcp-url> <api-key> [tool] ['<json-args>']");
  process.exit(1);
}

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { "X-API-Key": key } },
  }),
);

if (!tool) {
  const { tools } = await client.listTools();
  console.log(`Connected. ${tools.length} tools:\n`);
  for (const t of tools)
    console.log(` - ${t.name}: ${(t.description ?? "").split("\n")[0].slice(0, 90)}`);
} else {
  const r = await client.callTool({ name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} });
  const text = r.content?.map((c) => c.text ?? "").join("\n") ?? "";
  if (r.isError) {
    console.error("TOOL ERROR:\n" + text.slice(0, 2000));
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2).slice(0, 6000));
  } catch {
    console.log(text.slice(0, 6000));
  }
}
await client.close();
