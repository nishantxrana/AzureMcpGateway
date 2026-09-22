#!/usr/bin/env node
/**
 * onboard-org.mjs — append an org to config/orgs.json and print Key Vault / Copilot Studio steps.
 * Never accepts secret values as CLI args.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs, printHelp, resolveFromRoot } from "./verify/_lib.mjs";

// Validate with the gateway's own schema (built output), so the tool can never write
// an entry the gateway would refuse to start with.
const registryModule = resolveFromRoot("dist/config/registry.js");
if (!existsSync(registryModule)) {
  console.error(
    "dist/ not found. Run `npm run build` first (or use `npm run onboard -- ...`, which builds).",
  );
  process.exit(1);
}
const { registrySchema } = await import(pathToFileURL(registryModule).href);

const args = parseArgs();
if (args.help || !args.alias || !args.org || !args.auth) {
  printHelp(
    "onboard-org",
    "node scripts/onboard-org.mjs --alias <a> --org <adoOrg> --auth pat|entra-sp --domains core,repositories,... [--tenant <uuid> --client <uuid>]",
    {
      alias: "URL alias",
      org: "ADO org name",
      auth: "pat | entra-sp",
      domains: "Comma-separated domains",
      tenant: "Entra tenant id (entra-sp)",
      client: "App client id (entra-sp)",
      help: "Show help",
    },
  );
  if (args.help) process.exit(0);
  process.exit(1);
}

const alias = String(args.alias);
const adoOrg = String(args.org);
const authType = String(args.auth);
const domains = String(args.domains ?? "core,repositories,pipelines,work-items,wiki")
  .split(/[,\s]+/)
  .filter(Boolean);

const registryPath = resolveFromRoot("config/orgs.json");
const registry = JSON.parse(readFileSync(registryPath, "utf8"));

if (registry.orgs.some((o) => o.alias === alias)) {
  console.error(`Alias already exists: ${alias}`);
  process.exit(1);
}

if (authType === "entra-sp" && (!args.tenant || !args.client)) {
  console.error("entra-sp requires --tenant and --client");
  process.exit(1);
}

const entry = {
  alias,
  displayName: alias,
  adoOrg,
  domains,
  auth:
    authType === "entra-sp"
      ? {
          type: "entra-sp",
          tenantId: String(args.tenant),
          clientId: String(args.client),
          secret: `ado-${alias}-sp-secret`,
        }
      : { type: "pat", secret: `ado-${alias}-pat` },
  clientKeys: [`mcp-${alias}-key-a`, `mcp-${alias}-key-b`],
  toolPolicy: { extraAllow: [], extraDeny: [] },
  limits: { ratePerMinute: 120, maxResponseChars: 60000 },
  instructions: "Use small 'top' values. Discover project names with core_list_projects first.",
};

if (authType !== "pat" && authType !== "entra-sp") {
  console.error(`--auth must be "pat" or "entra-sp" (got "${authType}")`);
  process.exit(1);
}

const candidate = {
  ...registry,
  orgs: [...registry.orgs, entry].sort((x, y) => x.alias.localeCompare(y.alias)),
};
const check = registrySchema.safeParse(candidate);
if (!check.success) {
  console.error("Refusing to write config/orgs.json. The new entry is invalid:");
  for (const i of check.error.issues) {
    console.error(`  - ${i.path.join(".") || "(root)"}: ${i.message}`);
  }
  process.exit(1);
}

writeFileSync(registryPath, JSON.stringify(candidate, null, 2) + "\n", "utf8");
console.log(`Updated ${registryPath} (validated)`);

console.log("");
console.log("Create secrets (values never echo to argv history if you use read):");
const secrets =
  authType === "pat"
    ? [`ado-${alias}-pat`, `mcp-${alias}-key-a`]
    : [`ado-${alias}-sp-secret`, `mcp-${alias}-key-a`];

for (const name of secrets) {
  console.log(
    `az keyvault secret set --vault-name <vault> --name ${name} --value "$(read -rs -p '${name}: ' v; echo "$v"; echo >&2)"`,
  );
}

console.log("");
console.log("Copilot Studio entry:");
console.log(`  Server URL: https://<host>/mcp/${alias}`);
console.log("  Auth: API key");
console.log("  Type: Header");
console.log("  Header name: X-API-Key");
console.log(`  Header value: (value of mcp-${alias}-key-a)`);

console.log("");
console.log(
  `(Optional) mcp-${alias}-key-b: create it only when rotating keys, see docs/RUNBOOK.md.`,
);
console.log("");
console.log("After the Key Vault secrets exist, verify through a running gateway:");
console.log(`  npm run verify:org -- --base <url> --alias ${alias} --key <key>`);
