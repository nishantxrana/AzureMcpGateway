#!/usr/bin/env node
/**
 * verify:secrets — gitleaks if present, else built-in regex scan.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import {
  nodeMajorOk,
  parseArgs,
  printHelp,
  preflight,
  resolveFromRoot,
  resultTable,
  runCommand,
} from "./_lib.mjs";

const args = parseArgs();
if (args.help) {
  printHelp("verify:secrets", "node scripts/verify/secrets-scan.mjs", {
    help: "Show help",
  });
  process.exit(0);
}

preflight([
  {
    name: "Node >= 22",
    ok: nodeMajorOk(),
    detail: process.versions.node,
    fix: "Install Node 22",
  },
]);

const rows = [];
const gitignore = resolveFromRoot(".gitignore");
const gitignoreText = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
const envIgnored =
  gitignoreText.includes(".env") || gitignoreText.includes(".env*");
rows.push({
  check: ".env gitignored",
  result: envIgnored ? "PASS" : "FAIL",
  detail: envIgnored ? ".env* ignored" : "add .env* to .gitignore",
});

const gitleaks = runCommand("gitleaks", ["version"]);
if (gitleaks.status === 0) {
  const r = runCommand("gitleaks", ["detect", "--source", resolveFromRoot("."), "--no-git", "-v"]);
  rows.push({
    check: "gitleaks",
    result: r.status === 0 ? "PASS" : "FAIL",
    detail: r.status === 0 ? "clean" : (r.stdout || r.stderr || "findings").slice(0, 200),
  });
} else {
  const patterns = [
    { name: "ado-pat-like", re: /\b[a-z2-7]{52}\b/gi },
    { name: "azure-client-secret-assign", re: /AZURE_CLIENT_SECRET\s*=\s*\S+/g },
    { name: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  ];
  const skipDirs = new Set([
    "node_modules",
    "dist",
    ".git",
    "artifacts",
    "coverage",
    ".cursor",
  ]);
  const findings = [];

  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      if (skipDirs.has(entry)) continue;
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && st.size < 2_000_000) {
        if (/\.(png|jpg|jpeg|gif|webp|zip|node|map)$/i.test(entry)) continue;
        if (/^\.env/i.test(entry) && entry !== ".env.example") {
          findings.push(`committed-env-file:${path.relative(resolveFromRoot("."), full)}`);
          continue;
        }
        let text;
        try {
          text = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        // Skip known sample / fixture noise
        if (full.includes(`${path.sep}test${path.sep}fixtures${path.sep}`)) continue;
        if (full.includes(`${path.sep}reference${path.sep}`)) continue;
        for (const p of patterns) {
          if (p.re.test(text)) {
            findings.push(`${p.name}:${path.relative(resolveFromRoot("."), full)}`);
          }
          p.re.lastIndex = 0;
        }
      }
    }
  }
  walk(resolveFromRoot("."));
  rows.push({
    check: "builtin secret scan",
    result: findings.length === 0 ? "PASS" : "FAIL",
    detail: findings.length === 0 ? "no matches" : findings.slice(0, 10).join("; "),
  });
}

process.exit(resultTable(rows) ? 0 : 1);
