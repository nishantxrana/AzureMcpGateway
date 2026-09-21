#!/usr/bin/env node
/**
 * verify:local — full offline test matrix (no network, no Azure).
 */
import {
  nodeMajorOk,
  preflight,
  resultTable,
  resolveFromRoot,
  fileExists,
  runCommand,
  describeFailure,
} from "./_lib.mjs";

const root = resolveFromRoot(".");

preflight([
  {
    name: "Node >= 22",
    ok: nodeMajorOk(),
    detail: `node ${process.versions.node}`,
    fix: "Install Node.js 22 LTS",
  },
  {
    name: "package.json",
    ok: fileExists(resolveFromRoot("package.json")),
    detail: "present",
    fix: "Run from repo root",
  },
  {
    name: "fake ADO fixture",
    ok: fileExists(resolveFromRoot("test/fixtures/fake-ado-mcp.mjs")),
    detail: "present",
    fix: "Restore test/fixtures/fake-ado-mcp.mjs",
  },
  {
    name: "config/orgs.json",
    ok: fileExists(resolveFromRoot("config/orgs.json")),
    detail: "present",
    fix: "Create config/orgs.json from orgs.example.json",
  },
]);

const started = Date.now();
const env = {
  ...process.env,
  NODE_ENV: "test",
  ADO_MCP_BIN: resolveFromRoot("test/fixtures/fake-ado-mcp.mjs"),
};

const steps = [
  { name: "lint", cmd: ["npm", "run", "lint"] },
  { name: "build", cmd: ["npm", "run", "build"] },
  { name: "typecheck", cmd: ["npm", "run", "typecheck"] },
  { name: "unit+integration tests", cmd: ["npm", "test"] },
];

const rows = [];
for (const step of steps) {
  const r = runCommand(step.cmd[0], step.cmd.slice(1), { cwd: root, env });
  const ok = r.status === 0;
  rows.push({
    check: step.name,
    result: ok ? "PASS" : "FAIL",
    detail: ok ? "ok" : describeFailure(r),
  });
  // Keep going: one run should show every failing step, not just the first.
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
rows.push({
  check: "duration",
  result: Number(elapsed) < 60 ? "PASS" : "WARN",
  detail: `${elapsed}s (budget 60s)`,
});

const allOk = resultTable(rows);
process.exit(allOk ? 0 : 1);
