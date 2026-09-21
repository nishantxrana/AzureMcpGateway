// Runs Microsoft's official Azure DevOps MCP server (stdio) behind mcp-proxy,
// which exposes it as Streamable HTTP at /mcp, protected by an X-API-Key header.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  ADO_ORG,
  ADO_PAT,
  MCP_API_KEY,
  ADO_DOMAINS = "core repositories pipelines work-items wiki", // space or comma separated; "all" for everything
  PORT = "8080",
} = process.env;

const missing = Object.entries({ ADO_ORG, ADO_PAT, MCP_API_KEY }).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing required app settings: ${missing.join(", ")}`);
  process.exit(1);
}

const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
const proxyBin = path.join(pkgDir("mcp-proxy"), "dist", "bin", "mcp-proxy.mjs");
const adoBin = path.join(pkgDir("@azure-devops/mcp"), "dist", "index.js");

const domains = ADO_DOMAINS.split(/[\s,]+/).filter(Boolean);

const child = spawn(
  process.execPath,
  [
    proxyBin,
    "--host", "0.0.0.0",
    "--port", PORT,
    "--server", "stream",
    "--streamEndpoint", "/mcp",
    "--stateless",
    "--apiKey", MCP_API_KEY,
    "--",
    process.execPath, adoBin, ADO_ORG,
    "--authentication", "pat",
    "--domains", ...domains,
  ],
  {
    stdio: "inherit",
    // The official server wants base64("<any email>:<pat>") in PERSONAL_ACCESS_TOKEN.
    env: { ...process.env, PERSONAL_ACCESS_TOKEN: Buffer.from(`mcp:${ADO_PAT}`).toString("base64") },
  }
);

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 1));
