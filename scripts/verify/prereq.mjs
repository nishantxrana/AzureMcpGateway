#!/usr/bin/env node
/**
 * verify:prereq — shared preflight for Node, optional az, registry, env, vault names.
 */
import {
  azAvailable,
  fileExists,
  nodeMajorOk,
  parseArgs,
  printHelp,
  preflight,
  readJson,
  resolveFromRoot,
  resultTable,
} from "./_lib.mjs";

const args = parseArgs();
if (args.help) {
  printHelp(
    "verify:prereq",
    "node scripts/verify/prereq.mjs [--vault <name>]",
    {
      vault: "Optional Key Vault name (checks secret names exist via az, values never logged)",
      help: "Show help",
    },
  );
  process.exit(0);
}

const registryPath = resolveFromRoot("config/orgs.json");
let registryOk = false;
let registryDetail = "missing";
try {
  const reg = readJson(registryPath);
  registryOk = reg.version === 1 && Array.isArray(reg.orgs) && reg.orgs.length > 0;
  registryDetail = registryOk ? `${reg.orgs.length} org(s)` : "invalid";
} catch (e) {
  registryDetail = e instanceof Error ? e.message : "parse error";
}

preflight([
  {
    name: "Node >= 22",
    ok: nodeMajorOk(),
    detail: process.versions.node,
    fix: "Install Node 22 LTS",
  },
  {
    name: "config/orgs.json",
    ok: registryOk,
    detail: registryDetail,
    fix: "Fix registry or copy from orgs.example.json",
  },
]);

const rows = [
  {
    check: "node",
    result: nodeMajorOk() ? "PASS" : "FAIL",
    detail: process.versions.node,
  },
  {
    check: "registry",
    result: registryOk ? "PASS" : "FAIL",
    detail: registryDetail,
  },
  {
    check: "az cli",
    result: azAvailable() ? "PASS" : "WARN",
    detail: azAvailable() ? "available" : "not logged in / not installed (ok for local-only)",
  },
];

if (args.vault) {
  if (!azAvailable()) {
    rows.push({
      check: "vault secrets",
      result: "FAIL",
      detail: "az required when --vault given",
    });
  } else {
    const reg = readJson(registryPath);
    const needed = new Set();
    for (const org of reg.orgs) {
      needed.add(org.auth.secret);
      for (const k of org.clientKeys) needed.add(k);
    }
    needed.add("mcp-admin-key");
    // Names only — never print values
    const { runCommand } = await import("./_lib.mjs");
    let missing = 0;
    for (const name of needed) {
      const r = runCommand("az", [
        "keyvault", "secret", "show", "--vault-name", String(args.vault),
        "--name", name, "--query", "name", "-o", "tsv",
      ]);
      if (r.status !== 0) missing++;
    }
    rows.push({
      check: "vault secret names",
      result: missing === 0 ? "PASS" : "FAIL",
      detail: missing === 0 ? `${needed.size} names present` : `${missing} missing (names only checked)`,
    });
  }
}

process.exit(resultTable(rows) ? 0 : 1);
