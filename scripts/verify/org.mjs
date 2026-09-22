#!/usr/bin/env node
/**
 * verify:org — live smoke through gateway against real ADO.
 */
import { nodeMajorOk, parseArgs, printHelp, preflight, resultTable } from "./_lib.mjs";

const args = parseArgs();
if (args.help || !args.base || !args.alias || !args.key) {
  printHelp("verify:org", "node scripts/verify/org.mjs -- --base <url> --alias <a> --key <k>", {
    base: "Gateway base URL (e.g. http://127.0.0.1:8080)",
    alias: "Org alias",
    key: "Client API key for that alias",
    help: "Show help",
  });
  if (args.help) process.exit(0);
  console.error("Missing required --base --alias --key");
  process.exit(1);
}

preflight([
  { name: "Node >= 22", ok: nodeMajorOk(), detail: process.versions.node, fix: "Install Node 22" },
  { name: "base url", ok: Boolean(args.base), detail: String(args.base), fix: "Pass --base" },
]);

const base = String(args.base).replace(/\/$/, "");
const alias = String(args.alias);
const key = String(args.key);

async function mcp(method, params) {
  const res = await fetch(`${base}/mcp/${alias}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": key,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, rawLen: text.length };
}

function toolText(body) {
  const result = body?.result ?? body;
  const content = result?.content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

function mapPerm(domain, errText) {
  if (!/401|403|Failed request:\s*\(401\)/i.test(errText)) return null;
  const map = {
    repositories: "Code (Read)",
    pipelines: "Build (Read)",
    wiki: "Wiki (Read)",
    "work-items": "Work Items (Read)",
    core: "Project and Team (Read)",
  };
  return map[domain] ?? "unknown permission";
}

/** The payload sits between the UNTRUSTED envelope's first and last line. */
function firstProjectName(text) {
  const lines = text.split("\n");
  const payload = /^<<[0-9a-f]+>> \[UNTRUSTED/.test(lines[0] ?? "")
    ? lines.slice(1, -1).join("\n")
    : text;
  try {
    const parsed = JSON.parse(payload);
    const list = Array.isArray(parsed) ? parsed : (parsed?.value ?? []);
    const name = list.find((x) => typeof x?.name === "string")?.name;
    if (name) return name;
  } catch {
    // fall through to the loose match
  }
  return /"name"\s*:\s*"([^"]+)"/.exec(payload)?.[1];
}

const rows = [];
try {
  await mcp("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify-org", version: "1" },
  });
  const listed = await mcp("tools/list", {});
  const tools = listed.body?.result?.tools ?? listed.body?.tools ?? [];
  rows.push({
    check: "tools/list",
    result: listed.status === 200 && Array.isArray(tools) ? "PASS" : "FAIL",
    detail: Array.isArray(tools) ? `${tools.length} tools` : `HTTP ${listed.status}`,
  });

  const projectsCall = await mcp("tools/call", {
    name: "core_list_projects",
    arguments: {},
  });
  const projectsText = toolText(projectsCall.body);
  const projectsOk =
    projectsCall.status === 200 && !projectsCall.body?.result?.isError && projectsText.length > 0;
  rows.push({
    check: "core_list_projects",
    result: projectsOk ? "PASS" : "FAIL",
    detail: projectsOk ? `chars=${projectsText.length}` : projectsText.slice(0, 200),
  });

  // Pick the first real project so project-scoped reads are meaningful.
  const project = firstProjectName(projectsText);
  rows.push({
    check: "first project",
    result: project ? "PASS" : "FAIL",
    detail:
      project ??
      "core_list_projects returned no projects: the identity has no project access (add it to Readers)",
  });

  const enabled = new Set(tools.map((t) => t.name));
  // One cheap real read per enabled domain. Only a clean, non-error result is a PASS.
  const probes = [
    { domain: "repositories", name: "repo_repository", args: { action: "list", project } },
    { domain: "pipelines", name: "pipelines_definition", args: { action: "list", project } },
    { domain: "pipelines", name: "pipelines_build", args: { action: "list", project, top: 1 } },
    { domain: "wiki", name: "wiki", args: { action: "list_wikis", project } },
    {
      domain: "work-items",
      name: "wit_query",
      args: {
        action: "wiql",
        project,
        top: 1,
        wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project",
      },
    },
  ];

  for (const p of probes) {
    const label = `${p.domain}: ${p.name}`;
    if (!project) {
      rows.push({ check: label, result: "WARN", detail: "skipped: no project available" });
      continue;
    }
    if (!enabled.has(p.name)) {
      rows.push({
        check: label,
        result: "WARN",
        detail: "skipped: tool not enabled for this alias",
      });
      continue;
    }
    const r = await mcp("tools/call", { name: p.name, arguments: p.args });
    const text = toolText(r.body);
    const isErr = Boolean(r.body?.result?.isError) || r.status >= 400;
    const missing = mapPerm(p.domain, text);

    if (missing) {
      rows.push({ check: label, result: "FAIL", detail: `missing PAT scope: ${missing}` });
    } else if (isErr && /not permitted/i.test(text)) {
      rows.push({
        check: label,
        result: "FAIL",
        detail: `blocked by gateway policy (probe bug or policy too tight): ${text.slice(0, 140)}`,
      });
    } else if (isErr) {
      rows.push({ check: label, result: "FAIL", detail: text.slice(0, 200) || `HTTP ${r.status}` });
    } else {
      rows.push({
        check: label,
        result: "PASS",
        detail:
          text.length > 0 ? `${text.length} chars returned (empty list is fine)` : "empty result",
      });
    }
  }
} catch (e) {
  rows.push({
    check: "verify:org",
    result: "FAIL",
    detail: (e instanceof Error ? e.message : String(e)).slice(0, 300),
  });
}

console.log("");
console.log("REMINDER: PATs must be organization-scoped. Global PATs stop working 2026-12-01.");
process.exit(resultTable(rows) ? 0 : 1);
