#!/usr/bin/env node
/**
 * Shared helpers for verification scripts: preflight table, result table, argv parsing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function printHelp(name, usage, options) {
  console.log(`Usage: ${usage}`);
  console.log("");
  for (const [flag, desc] of Object.entries(options)) {
    console.log(`  --${flag.padEnd(20)} ${desc}`);
  }
}

export function preflight(checks) {
  console.log("PREFLIGHT");
  let ok = true;
  for (const c of checks) {
    const pass = Boolean(c.ok);
    console.log(`${pass ? "PASS" : "FAIL"} | ${c.name} | ${c.detail}${pass ? "" : ` | fix: ${c.fix ?? "see docs"}`}`);
    if (!pass) ok = false;
  }
  if (!ok) {
    console.log("PREFLIGHT FAILED — aborting before work");
    process.exit(1);
  }
  console.log("");
}

export function resultTable(rows) {
  console.log("CHECK | RESULT | DETAIL");
  let pass = 0;
  let fail = 0;
  for (const r of rows) {
    console.log(`${r.check} | ${r.result} | ${r.detail}`);
    if (r.result === "PASS") pass++;
    else if (r.result === "FAIL") fail++;
  }
  console.log(`SUMMARY: ${pass} PASS, ${fail} FAIL`);
  return fail === 0;
}

export function nodeMajorOk() {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 22;
}

/**
 * Quote one argument for cmd.exe. Only used for the fixed set of known .cmd shims.
 * Never pass untrusted input through runCommand.
 */
function quoteWinArg(a) {
  const s = String(a);
  return /[\s"&|<>^%]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const WIN_SHIMS = new Set(["npm", "npx", "az", "gitleaks", "bicep"]);

/**
 * Cross-platform command runner.
 *
 * On Windows, npm / az / gitleaks are .cmd shims. Node (since the CVE-2024-27980
 * fix) refuses to spawn .cmd files without a shell, which surfaces as
 * `status === null` and "exit null". So:
 *  - npm is launched through `npm_execpath` with process.execPath (no shell) when
 *    we are running under npm, which is the normal case for `npm run ...`;
 *  - other known shims run through a shell with quoted arguments;
 *  - everything else (node, git, unzip) is spawned directly, no shell.
 */
export function runCommand(cmd, args = [], opts = {}) {
  const base = { encoding: "utf8", ...opts };
  if (cmd === "npm" && process.env.npm_execpath) {
    return spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
      ...base,
      shell: false,
    });
  }
  if (process.platform === "win32" && WIN_SHIMS.has(cmd)) {
    return spawnSync([cmd, ...args.map(quoteWinArg)].join(" "), [], {
      ...base,
      shell: true,
    });
  }
  return spawnSync(cmd, args, { ...base, shell: false });
}

/** Human-readable reason a spawn failed (spawn error, stderr, or exit code). */
export function describeFailure(r, max = 500) {
  const text =
    r.error?.message ||
    `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim() ||
    `exit ${r.status}`;
  return String(text).replace(/\s+/g, " ").slice(-max);
}

export function azAvailable() {
  return runCommand("az", ["version", "-o", "json"]).status === 0;
}

export function azLoggedIn() {
  return runCommand("az", ["account", "show", "-o", "json"]).status === 0;
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function repoRoot() {
  return process.cwd();
}

export function resolveFromRoot(...parts) {
  return path.resolve(repoRoot(), ...parts);
}

export function fileExists(p) {
  return existsSync(p);
}
