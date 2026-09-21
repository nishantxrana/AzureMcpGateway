#!/usr/bin/env node
/**
 * parity.mjs — compare core_list_projects via gateway vs legacy/start.mjs.
 *
 * You run this with real credentials. Never pass secrets on the command line in shared logs.
 *
 * Gateway mode (gateway already running with EnvSecretProvider):
 *   node scripts/parity.mjs --gateway http://127.0.0.1:8080 --alias coolops --key "$KEY"
 *
 * Legacy mode (spawns legacy/start.mjs; needs ADO_ORG, ADO_PAT, MCP_API_KEY in env):
 *   ADO_ORG=coolops ADO_PAT=... MCP_API_KEY=... PORT=18080 node scripts/parity.mjs --legacy
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, printHelp } from "./verify/_lib.mjs";

const args = parseArgs();
if (args.help) {
  printHelp("parity", "node scripts/parity.mjs --gateway <url> --alias <a> --key <k> | --legacy", {
    gateway: "Running gateway base URL",
    alias: "Org alias",
    key: "API key",
    legacy: "Also start legacy/start.mjs and compare",
    help: "Show help",
  });
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function listProjects(url, apiKey) {
  // initialize
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "parity", version: "1" },
      },
    }),
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "core_list_projects", arguments: {} },
    }),
  });
  const body = await res.json();
  const text = (body?.result?.content ?? [])
    .map((c) => c.text ?? "")
    .join("\n");
  // Extract project names heuristically
  const names = new Set();
  try {
    const m = text.match(/\n(\[[\s\S]*\])\n/);
    const json = JSON.parse(m ? m[1] : text.replace(/^<<[\s\S]*?>>\n/, "").replace(/\n<<\/[\s\S]*$/, ""));
    const arr = Array.isArray(json) ? json : json.value ?? [];
    for (const p of arr) {
      if (p?.name) names.add(String(p.name));
    }
  } catch {
    for (const m of text.matchAll(/"name"\s*:\s*"([^"]+)"/g)) names.add(m[1]);
  }
  return { names: [...names].sort(), rawChars: text.length };
}

if (args.gateway) {
  const alias = String(args.alias ?? "coolops");
  const key = String(args.key ?? "");
  if (!key) {
    console.error("Missing --key");
    process.exit(1);
  }
  const gwUrl = `${String(args.gateway).replace(/\/$/, "")}/mcp/${alias}`;
  const gw = await listProjects(gwUrl, key);
  console.log(`gateway projects (${gw.names.length}): ${gw.names.join(", ")}`);

  if (args.legacy) {
    const port = process.env.PORT ?? "18080";
    const legacy = spawn(process.execPath, [path.join(root, "legacy", "start.mjs")], {
      cwd: root,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const leg = await listProjects(
        `http://127.0.0.1:${port}/mcp`,
        process.env.MCP_API_KEY ?? key,
      );
      console.log(`legacy projects (${leg.names.length}): ${leg.names.join(", ")}`);
      const same =
        gw.names.length === leg.names.length &&
        gw.names.every((n, i) => n === leg.names[i]);
      console.log(same ? "PARITY: PASS" : "PARITY: FAIL");
      process.exit(same ? 0 : 2);
    } finally {
      legacy.kill("SIGTERM");
    }
  } else {
    console.log("Gateway listing done. Re-run with --legacy (and ADO_* env) to compare.");
    process.exit(0);
  }
} else {
  console.error("Pass --gateway <url> --alias <a> --key <k> (optional --legacy)");
  process.exit(1);
}
