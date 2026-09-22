#!/usr/bin/env node
/**
 * verify:drift — compare official @azure-devops/mcp tools/actions to config/tool-snapshot.json
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileExists,
  nodeMajorOk,
  parseArgs,
  printHelp,
  preflight,
  resolveFromRoot,
  resultTable,
} from "./_lib.mjs";

const policy = JSON.parse(readFileSync(resolveFromRoot("config/tool-policy.json"), "utf8"));
const ALLOWED_ACTIONS = policy.allowedActions;
const NO_ACTION_TOOLS = new Set(policy.noActionTools);
const BLOCKED_ACTIONS = policy.reviewedBlockedActions ?? {};
const DEFAULT_ALLOW = new Set([...Object.keys(ALLOWED_ACTIONS), ...NO_ACTION_TOOLS]);

const args = parseArgs();
if (args.help) {
  printHelp("verify:drift", "node scripts/verify/tool-drift.mjs [--update]", {
    update: "Rewrite config/tool-snapshot.json after human review",
    help: "Show help",
  });
  process.exit(0);
}

const snapshotPath = resolveFromRoot("config/tool-snapshot.json");
const require = createRequire(import.meta.url);

preflight([
  {
    name: "Node >= 22",
    ok: nodeMajorOk(),
    detail: process.versions.node,
    fix: "Install Node 22",
  },
  {
    name: "@azure-devops/mcp",
    ok: (() => {
      try {
        require.resolve("@azure-devops/mcp/package.json");
        return true;
      } catch {
        return false;
      }
    })(),
    detail: "resolvable",
    fix: "npm ci",
  },
  {
    name: "tool-snapshot.json",
    ok: fileExists(snapshotPath) || Boolean(args.update),
    detail: fileExists(snapshotPath) ? "present" : "missing (use --update)",
    fix: "Commit config/tool-snapshot.json or pass --update",
  },
]);

const adoBin = path.join(
  path.dirname(require.resolve("@azure-devops/mcp/package.json")),
  "dist",
  "index.js",
);
const domains = ["core", "repositories", "pipelines", "work-items", "wiki"];

async function listOfficialTools() {
  // Prefer spawning a tiny Node helper that uses SDK Client + StdioClientTransport
  const helper = `
import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const require = createRequire(import.meta.url);
const bin = ${JSON.stringify(adoBin)};
const domains = ${JSON.stringify(domains)};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
  bin,
  "drift-dummy-org",
  "--authentication", "pat",
  "--tenant", "00000000-0000-0000-0000-000000000000",
  "--domains", ...domains,
],
  env: { PATH: process.env.PATH || "", PERSONAL_ACCESS_TOKEN: Buffer.from("mcp:dummy").toString("base64") },
  stderr: "ignore",
});
const client = new Client({ name: "drift", version: "1" });
await client.connect(transport);
const { tools } = await client.listTools();
const out = tools.map((t) => {
  const props = t.inputSchema?.properties ?? {};
  const action = props.action;
  const actions = action?.enum ?? (action?.type === "string" ? [] : []);
  return { name: t.name, actions: Array.isArray(actions) ? actions : [] };
});
process.stdout.write(JSON.stringify(out));
await client.close();
process.exit(0);
`;
  const tmp = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "artifacts",
    "drift-list.tmp.mjs",
  );
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.dirname(tmp), { recursive: true });
  writeFileSync(tmp, helper, "utf8");

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tmp], {
      cwd: resolveFromRoot("."),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      rmSync(tmp, { force: true });
      reject(e);
    });
    child.on("close", (code) => {
      rmSync(tmp, { force: true });
      try {
        if (code !== 0) {
          reject(new Error(`drift list failed (${code}): ${stderr.slice(0, 300)}`));
          return;
        }
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const rows = [];
try {
  const live = await listOfficialTools();
  const liveMap = new Map(live.map((t) => [t.name, t]));
  const pkgVersion = JSON.parse(
    readFileSync(
      path.join(path.dirname(require.resolve("@azure-devops/mcp/package.json")), "package.json"),
      "utf8",
    ),
  ).version;

  if (args.update) {
    const snapshot = {
      version: 1,
      generatedFrom: `@azure-devops/mcp@${pkgVersion}`,
      domains,
      tools: live
        .map((t) => ({ name: t.name, actions: [...t.actions] }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    rows.push({
      check: "snapshot update",
      result: "PASS",
      detail: `wrote ${live.length} tools from @azure-devops/mcp@${pkgVersion}; review the diff before committing`,
    });
  } else {
    const snap = JSON.parse(readFileSync(snapshotPath, "utf8"));
    const snapMap = new Map(snap.tools.map((t) => [t.name, t]));
    const added = [...liveMap.keys()].filter((n) => !snapMap.has(n));
    const removed = [...snapMap.keys()].filter((n) => !liveMap.has(n));
    const actionDrift = [];
    for (const [name, t] of liveMap) {
      const s0 = snapMap.get(name);
      if (!s0) continue;
      const a = new Set(t.actions);
      const b = new Set(s0.actions ?? []);
      const onlyA = [...a].filter((x) => !b.has(x));
      const onlyB = [...b].filter((x) => !a.has(x));
      if (onlyA.length || onlyB.length) {
        actionDrift.push(`${name}(+${onlyA.join(",")}/-${onlyB.join(",")})`);
      }
    }
    rows.push({
      check: "tools added",
      result: added.length === 0 ? "PASS" : "FAIL",
      detail: added.length ? added.join(",") : "none",
    });
    rows.push({
      check: "tools removed",
      result: removed.length === 0 ? "PASS" : "FAIL",
      detail: removed.length ? removed.join(",") : "none",
    });
    rows.push({
      check: "action enums vs snapshot",
      result: actionDrift.length === 0 ? "PASS" : "FAIL",
      detail: actionDrift.length ? actionDrift.join("; ") : "match",
    });
  }

  // Policy checks always run against the LIVE tool list (never the snapshot),
  // so a package upgrade cannot pass by carrying a stale snapshot.
  const unreviewed = [];
  const missingUpstream = [];
  const mutationLooking = [];
  const MUTATION =
    /^(create|update|delete|remove|add|set|run|queue|retry|cancel|approve|vote|complete|abandon|reply|resolve|link|unlink|upsert|write|assign|merge|publish|trigger|reorder|move|rename|reset|restore|restart|stop|start|enable|disable|import|push|commit)/i;

  for (const t of live) {
    if (!DEFAULT_ALLOW.has(t.name)) continue;
    const allowed = ALLOWED_ACTIONS[t.name];
    if (!allowed) continue; // no-action tools carry no action enum
    const reviewed = new Set([...allowed, ...(BLOCKED_ACTIONS[t.name] ?? [])]);
    for (const action of t.actions) {
      if (!reviewed.has(action)) unreviewed.push(`${t.name}.${action}`);
    }
  }
  for (const [tool, actions] of Object.entries(ALLOWED_ACTIONS)) {
    const t = liveMap.get(tool);
    if (!t) {
      missingUpstream.push(`${tool} (tool missing)`);
      continue;
    }
    for (const a of actions) {
      if (!t.actions.includes(a)) missingUpstream.push(`${tool}.${a}`);
      if (MUTATION.test(a)) mutationLooking.push(`${tool}.${a}`);
    }
  }
  for (const n of NO_ACTION_TOOLS) {
    if (!liveMap.has(n)) missingUpstream.push(`${n} (tool missing)`);
  }

  rows.push({
    check: "unreviewed actions on allowlisted tools",
    result: unreviewed.length === 0 ? "PASS" : "FAIL",
    detail: unreviewed.length
      ? `${unreviewed.join(", ")} - review, then add to allowedActions or reviewedBlockedActions in config/tool-policy.json`
      : "none",
  });
  rows.push({
    check: "policy actions exist upstream",
    result: missingUpstream.length === 0 ? "PASS" : "FAIL",
    detail: missingUpstream.length ? missingUpstream.join(", ") : "all present",
  });
  rows.push({
    check: "allowed actions look read-only",
    result: mutationLooking.length === 0 ? "PASS" : "FAIL",
    detail: mutationLooking.length ? mutationLooking.join(", ") : "none",
  });
} catch (e) {
  rows.push({
    check: "drift run",
    result: "FAIL",
    detail: (e instanceof Error ? e.message : String(e)).slice(0, 300),
  });
}

process.exit(resultTable(rows) ? 0 : 1);
