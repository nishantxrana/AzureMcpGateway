#!/usr/bin/env node
/**
 * verify:package — validate deployment zip (entries, version pin, ELF natives).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  nodeMajorOk,
  parseArgs,
  printHelp,
  preflight,
  resolveFromRoot,
  resultTable,
} from "./_lib.mjs";

const args = parseArgs();
if (args.help || !args.zip) {
  printHelp("verify:package", "node scripts/verify/package.mjs -- --zip <path>", {
    zip: "Path to gateway zip",
    help: "Show help",
  });
  if (args.help) process.exit(0);
  process.exit(1);
}

preflight([
  { name: "Node >= 22", ok: nodeMajorOk(), detail: process.versions.node, fix: "Install Node 22" },
  {
    name: "zip exists",
    ok: existsSync(String(args.zip)),
    detail: String(args.zip),
    fix: "Pass a real --zip path",
  },
]);

const zipPath = path.resolve(String(args.zip));
const rows = [];
const shaPath = `${zipPath}.sha256`;

if (existsSync(shaPath)) {
  const expected = readFileSync(shaPath, "utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  rows.push({
    check: "sha256",
    result: expected === actual ? "PASS" : "FAIL",
    detail: expected === actual ? "match" : "mismatch",
  });
} else {
  rows.push({ check: "sha256", result: "WARN", detail: "no .sha256 sidecar" });
}

const sizeMb = statSync(zipPath).size / (1024 * 1024);
rows.push({
  check: "zip size",
  result: sizeMb > 250 ? "FAIL" : sizeMb > 100 ? "WARN" : "PASS",
  detail: `${sizeMb.toFixed(1)} MB`,
});

const tmp = path.join(resolveFromRoot("artifacts"), `pkg-verify-${Date.now()}`);
mkdirSync(tmp, { recursive: true });

let unzipped = false;
{
  const r = spawnSync("unzip", ["-q", zipPath, "-d", tmp], {
    encoding: "utf8",
    shell: false,
  });
  if (r.status === 0) unzipped = true;
}
if (!unzipped && process.platform === "win32") {
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}'`,
    ],
    { encoding: "utf8", shell: false },
  );
  unzipped = r.status === 0;
}
rows.push({
  check: "unzip",
  result: unzipped ? "PASS" : "FAIL",
  detail: unzipped ? tmp : "failed to unzip",
});

if (!unzipped) {
  process.exit(resultTable(rows) ? 0 : 1);
}

const required = [
  "dist/index.js",
  "package.json",
  "package-lock.json",
  "config/orgs.json",
  "config/tool-snapshot.json",
  "config/tool-policy.json",
  "node_modules/@azure-devops/mcp/dist/index.js",
];
for (const rel of required) {
  const ok = existsSync(path.join(tmp, rel));
  rows.push({
    check: `entry ${rel}`,
    result: ok ? "PASS" : "FAIL",
    detail: ok ? "present" : "missing",
  });
}

const forbidden = [".env", "src", "test", "scripts", "infra", ".cursor", "docs", "legacy"];
for (const rel of forbidden) {
  const present = existsSync(path.join(tmp, rel));
  rows.push({
    check: `forbidden ${rel}`,
    result: present ? "FAIL" : "PASS",
    detail: present ? "present" : "absent",
  });
}

try {
  const lock = JSON.parse(readFileSync(path.join(tmp, "package-lock.json"), "utf8"));
  const ver =
    lock.packages?.["node_modules/@azure-devops/mcp"]?.version ??
    lock.dependencies?.["@azure-devops/mcp"]?.version;
  rows.push({
    check: "@azure-devops/mcp pin",
    result: ver === "2.10.0" ? "PASS" : "FAIL",
    detail: String(ver),
  });
} catch (e) {
  rows.push({
    check: "@azure-devops/mcp pin",
    result: "FAIL",
    detail: e instanceof Error ? e.message : "lock parse",
  });
}

function collectNodes(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) collectNodes(full, out);
    else if (name.endsWith(".node")) out.push(full);
  }
  return out;
}

// Some packages (for example @azure/msal-node-runtime, msal-node-extensions) ship prebuilt
// binaries for every OS. Those are inert on Linux and must not fail the check. What matters is
// that every binary the Linux loader can pick is ELF. A package built on Windows would leave a
// PE file where a Linux build leaves an ELF one (for example keytar/build/Release/keytar.node).
const FOREIGN_PLATFORM = /[\\/](windows|win32|macos|darwin)[\\/]|dpapi\.node$/i;
const allNodes = collectNodes(path.join(tmp, "node_modules"));
const nodes = allNodes.filter((n) => !FOREIGN_PLATFORM.test(n));
const foreignCount = allNodes.length - nodes.length;
let elfFail = 0;
for (const n of nodes) {
  const buf = readFileSync(n);
  const isElf = buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
  if (!isElf) elfFail++;
}
rows.push({
  check: "native .node ELF",
  result: elfFail === 0 ? "PASS" : "FAIL",
  detail:
    elfFail === 0
      ? `${nodes.length} Linux-loadable binaries are ELF` +
        (foreignCount ? ` (${foreignCount} other-platform prebuilds ignored)` : "")
      : `${elfFail}/${nodes.length} non-ELF (package must be built on Linux)`,
});

if (existsSync(path.join(tmp, "NOT_DEPLOYABLE.txt"))) {
  rows.push({
    check: "smoke start",
    result: "WARN",
    detail: "skipped: NOT DEPLOYABLE stamp (built off Linux or with --dry-run)",
  });
} else if (process.platform !== "linux") {
  rows.push({
    check: "smoke start",
    result: "WARN",
    detail: "skipped: only meaningful on Linux (the package is Linux-built)",
  });
} else {
  rows.push(await smokeStart(tmp));
}

/**
 * Start the unzipped package exactly as App Service would (node dist/index.js) and
 * require /healthz to answer. Catches missing files (e.g. config/tool-policy.json),
 * missing production dependencies and import errors, which unit tests cannot see.
 */
async function smokeStart(dir) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "development", // EnvSecretProvider: no Key Vault needed for a smoke test
      PORT: String(port),
      ORG_REGISTRY_PATH: "config/orgs.json",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString("utf8");
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  let healthy = false;
  for (let i = 0; i < 40 && !exited && !healthy; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      healthy = res.status === 200 && (await res.text()) === JSON.stringify({ status: "ok" });
    } catch {
      // not up yet
    }
  }
  child.kill("SIGKILL");
  return {
    check: "smoke start",
    result: healthy ? "PASS" : "FAIL",
    detail: healthy
      ? `/healthz ok on :${port}`
      : `did not become healthy: ${stderr.replace(/\s+/g, " ").slice(-300) || (exited ? "process exited" : "timeout")}`,
  };
}

rmSync(tmp, { recursive: true, force: true });
const fails = rows.filter((r) => r.result === "FAIL").length;
resultTable(rows);
process.exit(fails === 0 ? 0 : 1);
