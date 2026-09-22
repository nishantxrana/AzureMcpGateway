#!/usr/bin/env node
/**
 * postinstall — replace @azure/msal-node-extensions with a no-op stub.
 *
 * @azure-devops/mcp statically imports NativeBrokerPlugin from this package at
 * module load time (in its auth.js), purely to support the "interactive"/"azcli"
 * default OAuth auth type. This gateway only ever uses "pat" or "entra-sp" (env)
 * auth, which never construct that class -- but the static import still runs
 * unconditionally, and the real package depends on `keytar`, whose native binding
 * requires libsecret at runtime. That shared library is not present on Azure App
 * Service's built-in Linux Node image, so the import crashes the child process
 * before it can even start (MCP error -32000: Connection closed).
 *
 * Swapping in a stub that exports an inert NativeBrokerPlugin class removes the
 * keytar/libsecret dependency entirely, with zero behavior change for pat/entra-sp
 * auth (the class is never instantiated on those paths).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const target = path.resolve("node_modules/@azure/msal-node-extensions");
const keytar = path.resolve("node_modules/keytar");

rmSync(target, { recursive: true, force: true });
rmSync(keytar, { recursive: true, force: true });

if (!existsSync(target)) {
  mkdirSync(target, { recursive: true });
}

writeFileSync(
  path.join(target, "package.json"),
  JSON.stringify(
    { name: "@azure/msal-node-extensions", version: "5.3.5", type: "module", main: "index.js" },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  path.join(target, "index.js"),
  `// Stub -- see scripts/patch-msal-stub.mjs for why this exists.\n` +
    `export class NativeBrokerPlugin {\n  constructor() {}\n}\n`,
);

console.log(
  "patch-msal-stub: replaced @azure/msal-node-extensions with a no-op stub (no keytar/libsecret dependency)",
);
