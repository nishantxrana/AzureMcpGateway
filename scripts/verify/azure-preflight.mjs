#!/usr/bin/env node
/**
 * verify:azure — App Service / Key Vault configuration audit via az.
 */
import {
  azAvailable,
  azLoggedIn,
  runCommand,
  nodeMajorOk,
  parseArgs,
  printHelp,
  preflight,
  resultTable,
} from "./_lib.mjs";

const args = parseArgs();
if (args.help || !args.rg || !args.app || !args.kv) {
  printHelp(
    "verify:azure",
    "node scripts/verify/azure-preflight.mjs -- --rg <rg> --app <name> --kv <vault> [--slot staging]",
    {
      rg: "Resource group",
      app: "Web app name",
      kv: "Key Vault name",
      slot: "Optional slot name",
      help: "Show help",
    },
  );
  if (args.help) process.exit(0);
  process.exit(1);
}

preflight([
  { name: "Node >= 22", ok: nodeMajorOk(), detail: process.versions.node, fix: "Install Node 22" },
  { name: "az installed", ok: azAvailable(), detail: azAvailable() ? "ok" : "missing", fix: "Install Azure CLI" },
  { name: "az logged in", ok: azLoggedIn(), detail: azLoggedIn() ? "ok" : "not logged in", fix: "az login" },
]);

function azJson(argv) {
  const r = runCommand("az", [...argv, "-o", "json"]);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "az failed").slice(0, 300));
  return JSON.parse(r.stdout || "null");
}

const ALLOWED_SETTINGS = new Set([
  "KEY_VAULT_URI",
  "NODE_ENV",
  "ORG_REGISTRY_PATH",
  "CHILD_TIMEOUT_MS",
  "MAX_CONCURRENT_CHILDREN",
  "APPLICATIONINSIGHTS_CONNECTION_STRING",
  "WEBSITE_RUN_FROM_PACKAGE",
  "SCM_DO_BUILD_DURING_DEPLOYMENT",
]);

const rows = [];
try {
  const appName = String(args.app);
  const rg = String(args.rg);
  const kv = String(args.kv);
  const slot = args.slot ? String(args.slot) : undefined;

  const identity = azJson([
    "webapp",
    "identity",
    "show",
    "--resource-group",
    rg,
    "--name",
    appName,
    ...(slot ? ["--slot", slot] : []),
  ]);
  const hasMi = Boolean(identity?.principalId);
  rows.push({
    check: "system-assigned identity",
    result: hasMi ? "PASS" : "FAIL",
    detail: hasMi ? "present" : "missing",
  });

  const vault = azJson(["keyvault", "show", "--name", kv]);
  const rbac = vault?.properties?.enableRbacAuthorization === true;
  const softDelete = Boolean(vault?.properties?.enableSoftDelete ?? true);
  const purge = vault?.properties?.enablePurgeProtection === true;
  rows.push({ check: "KV RBAC", result: rbac ? "PASS" : "FAIL", detail: String(rbac) });
  rows.push({ check: "KV soft delete", result: softDelete ? "PASS" : "FAIL", detail: String(softDelete) });
  rows.push({ check: "KV purge protection", result: purge ? "PASS" : "FAIL", detail: String(purge) });

  const cfg = azJson([
    "webapp",
    "config",
    "show",
    "--resource-group",
    rg,
    "--name",
    appName,
    ...(slot ? ["--slot", slot] : []),
  ]);
  rows.push({
    check: "httpsOnly",
    result: cfg.httpsOnly ? "PASS" : "FAIL",
    detail: String(cfg.httpsOnly),
  });
  rows.push({
    check: "minTlsVersion",
    result: String(cfg.minTlsVersion).startsWith("1.2") ? "PASS" : "FAIL",
    detail: String(cfg.minTlsVersion),
  });
  rows.push({
    check: "ftpsState",
    result: cfg.ftpsState === "Disabled" ? "PASS" : "FAIL",
    detail: String(cfg.ftpsState),
  });
  rows.push({
    check: "alwaysOn",
    result: cfg.alwaysOn ? "PASS" : "FAIL",
    detail: String(cfg.alwaysOn),
  });
  rows.push({
    check: "healthCheckPath",
    result: cfg.healthCheckPath ? "PASS" : "FAIL",
    detail: String(cfg.healthCheckPath ?? ""),
  });
  rows.push({
    check: "remote debugging",
    result: !cfg.remoteDebuggingEnabled ? "PASS" : "FAIL",
    detail: String(cfg.remoteDebuggingEnabled),
  });
  rows.push({
    check: "linuxFxVersion",
    result: /NODE\|(22|20)-lts/i.test(String(cfg.linuxFxVersion ?? "")) ? "PASS" : "FAIL",
    detail: String(cfg.linuxFxVersion),
  });
  rows.push({
    check: "appCommandLine",
    result: cfg.appCommandLine === "node dist/index.js" ? "PASS" : "FAIL",
    detail: String(cfg.appCommandLine),
  });

  const settingsList = azJson([
    "webapp",
    "config",
    "appsettings",
    "list",
    "--resource-group",
    rg,
    "--name",
    appName,
    ...(slot ? ["--slot", slot] : []),
  ]);
  const settings = Object.fromEntries(
    (settingsList ?? []).map((s) => [s.name, s.value]),
  );
  rows.push({
    check: "WEBSITE_RUN_FROM_PACKAGE",
    result: settings.WEBSITE_RUN_FROM_PACKAGE === "1" ? "PASS" : "FAIL",
    detail: String(settings.WEBSITE_RUN_FROM_PACKAGE),
  });
  rows.push({
    check: "SCM_DO_BUILD_DURING_DEPLOYMENT",
    result: settings.SCM_DO_BUILD_DURING_DEPLOYMENT === "false" ? "PASS" : "FAIL",
    detail: String(settings.SCM_DO_BUILD_DURING_DEPLOYMENT),
  });

  let secretLike = 0;
  for (const [name, value] of Object.entries(settings)) {
    const platform =
      name.startsWith("WEBSITE_") ||
      name.startsWith("APPINSIGHTS_") ||
      name.startsWith("ApplicationInsights") ||
      ALLOWED_SETTINGS.has(name);
    if (!platform) secretLike++;
    if (
      typeof value === "string" &&
      value.length > 40 &&
      /[A-Za-z0-9+/=_-]{40,}/.test(value) &&
      !ALLOWED_SETTINGS.has(name) &&
      !name.startsWith("WEBSITE_")
    ) {
      secretLike++;
    }
  }
  rows.push({
    check: "no plaintext secrets in app settings",
    result: secretLike === 0 ? "PASS" : "FAIL",
    detail: secretLike === 0 ? "allowlisted settings only" : `${secretLike} suspicious`,
  });

  // Slot presence
  try {
    const slots = azJson([
      "webapp",
      "deployment",
      "slot",
      "list",
      "--resource-group",
      rg,
      "--name",
      appName,
    ]);
    if (Array.isArray(slots) && slots.length > 0) {
      rows.push({
        check: "staging slot",
        result: "PASS",
        detail: slots.map((s) => s.name).join(","),
      });
    } else {
      rows.push({
        check: "staging slot",
        result: "WARN",
        detail: "no slot (SKU does not support it)",
      });
    }
  } catch {
    rows.push({
      check: "staging slot",
      result: "WARN",
      detail: "no slot (SKU does not support it)",
    });
  }

  rows.push({
    check: "diagnostic settings",
    result: "WARN",
    detail: "confirm Log Analytics diagnostics in portal if not asserted here",
  });
} catch (e) {
  rows.push({
    check: "verify:azure",
    result: "FAIL",
    detail: (e instanceof Error ? e.message : String(e)).slice(0, 300),
  });
}

process.exit(resultTable(rows) ? 0 : 1);
