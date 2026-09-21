// REFERENCE ONLY - verified working spike (multi-org gateway core).
// Proven here: /mcp/:alias routing, per-alias key + domains, default-deny tool allowlist,
// blocked-tool rejection, cross-org key isolation, stdio->Streamable HTTP bridging.
// NOT production: secrets are hard-coded, 404/401 differ (must be uniform 401), no limits/logging/timeouts.
import express from "express";
import path from "node:path";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const require = createRequire(import.meta.url);
const adoBin = path.join(path.dirname(require.resolve("@azure-devops/mcp/package.json")), "dist", "index.js");

// alias -> org config (secrets would come from Key Vault in the real thing)
const ORGS = {
  coolops:  { org: "coolops",  pat: "fake-pat-1", key: "key-coolops",  domains: ["core","repositories","pipelines"] },
  otherorg: { org: "otherorg", pat: "fake-pat-2", key: "key-other",    domains: ["core","wiki"] },
};
const ALLOW = new Set(["core_list_projects","core_list_project_teams","repo_repository","repo_pull_request","repo_pull_request_thread","repo_branch","repo_file","repo_search_commits","pipelines_build","pipelines_build_log","pipelines_definition","pipelines_run","wit_work_item","wit_query","wit_backlog","wiki"]);

async function withChild(cfg, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [adoBin, cfg.org, "--authentication", "pat", "--domains", ...cfg.domains],
    env: { PATH: process.env.PATH, PERSONAL_ACCESS_TOKEN: Buffer.from(`mcp:${cfg.pat}`).toString("base64") },
    stderr: "ignore",
  });
  const client = new Client({ name: "gateway", version: "1.0.0" });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close().catch(() => {}); }
}

const toolCache = new Map(); // alias -> tools
async function listTools(alias, cfg) {
  if (toolCache.has(alias)) return toolCache.get(alias);
  const tools = await withChild(cfg, async (c) => (await c.listTools()).tools.filter((t) => ALLOW.has(t.name)));
  toolCache.set(alias, tools);
  return tools;
}

function buildServer(alias, cfg) {
  const server = new Server({ name: `ado-gateway/${alias}`, version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools(alias, cfg) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (!ALLOW.has(name)) return { isError: true, content: [{ type: "text", text: `Tool not permitted: ${name}` }] };
    return withChild(cfg, (c) => c.callTool({ name, arguments: args }));
  });
  return server;
}

const app = express();
app.use(express.json());
app.post("/mcp/:alias", async (req, res) => {
  const cfg = ORGS[req.params.alias];
  if (!cfg || req.get("x-api-key") !== cfg.key) return res.status(cfg ? 401 : 404).json({ error: "denied" });
  const server = buildServer(req.params.alias, cfg);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.listen(8095, () => console.log("spike gateway on 8095"));
