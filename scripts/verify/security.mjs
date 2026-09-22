#!/usr/bin/env node
/**
 * verify:security — black-box security checks against a running gateway.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  nodeMajorOk,
  parseArgs,
  printHelp,
  preflight,
  resolveFromRoot,
  resultTable,
} from "./_lib.mjs";

const args = parseArgs();
if (args.help || !args.base || !args.alias || !args.key) {
  printHelp(
    "verify:security",
    "node scripts/verify/security.mjs -- --base <url> --alias <a> --key <k> [--expect-revoked <key>]",
    {
      base: "Gateway base URL",
      alias: "Known alias",
      key: "Valid API key",
      "expect-revoked": "Optional key that must fail after rotation",
      "test-limits":
        "Also probe the failed-request throttle (automatic for localhost; opt-in elsewhere)",
      help: "Show help",
    },
  );
  if (args.help) process.exit(0);
  process.exit(1);
}

preflight([
  { name: "Node >= 22", ok: nodeMajorOk(), detail: process.versions.node, fix: "Install Node 22" },
]);

const base = String(args.base).replace(/\/$/, "");
const alias = String(args.alias);
const key = String(args.key);
const rows = [];

function digest(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function rawPost(path, headers, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

function toolResult(text) {
  try {
    return JSON.parse(text)?.result;
  } catch {
    return undefined;
  }
}

async function call(name, argumentsObj) {
  return rawPost(
    `/mcp/${alias}`,
    { "x-api-key": key },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: argumentsObj } },
  );
}

const LEAK = /\bat\s+\S+\s+\(|node_modules|[A-Za-z]:\\|\/home\/|\/usr\/|stack/i;

// Uniform 401 bodies
const cases = [
  {
    name: "no key",
    path: `/mcp/${alias}`,
    headers: {},
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  },
  {
    name: "wrong key",
    path: `/mcp/${alias}`,
    headers: { "x-api-key": "definitely-wrong-key" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  },
  {
    name: "unknown alias",
    path: `/mcp/unknown-alias-zz`,
    headers: { "x-api-key": key },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  },
];

const bodies = [];
for (const c of cases) {
  const r = await rawPost(c.path, c.headers, c.body);
  bodies.push(r.text);
  rows.push({
    check: `401 ${c.name}`,
    result: r.status === 401 ? "PASS" : "FAIL",
    detail: `HTTP ${r.status}`,
  });
}
const digests = bodies.map(digest);
const uniform = digests.every((d) => d === digests[0]);
rows.push({
  check: "uniform 401 body",
  result: uniform ? "PASS" : "FAIL",
  detail: uniform ? "byte-identical" : "bodies differ",
});

// GET 405
{
  const res = await fetch(`${base}/mcp/${alias}`, { method: "GET" });
  rows.push({
    check: "GET /mcp/:alias",
    result: res.status === 405 ? "PASS" : "FAIL",
    detail: `HTTP ${res.status}`,
  });
}

// unknown path 404
{
  const res = await fetch(`${base}/nope`);
  rows.push({
    check: "unknown path",
    result: res.status === 404 ? "PASS" : "FAIL",
    detail: `HTTP ${res.status}`,
  });
}

// oversized body 413
{
  const big = "x".repeat(300 * 1024);
  const r = await rawPost(
    `/mcp/${alias}`,
    { "x-api-key": key },
    `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"${big}"}}`,
  );
  rows.push({
    check: "body > 256KB",
    result: r.status === 413 ? "PASS" : "FAIL",
    detail: `HTTP ${r.status}`,
  });
}

// write tools blocked
{
  const r = await rawPost(
    `/mcp/${alias}`,
    { "x-api-key": key },
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "pipelines_write", arguments: {} },
    },
  );
  const denied = toolResult(r.text)?.isError === true && /not permitted/i.test(r.text);
  rows.push({
    check: "pipelines_write blocked",
    result: denied ? "PASS" : "FAIL",
    detail: r.text.slice(0, 120).replace(/\n/g, " "),
  });
}

// action create denied
{
  const r = await rawPost(
    `/mcp/${alias}`,
    { "x-api-key": key },
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "repo_repository", arguments: { action: "create" } },
    },
  );
  rows.push({
    check: "action create denied",
    result: /not permitted|Action not permitted/i.test(r.text) ? "PASS" : "FAIL",
    detail: r.text.slice(0, 120).replace(/\n/g, " "),
  });
}

// healthz exact body
{
  const res = await fetch(`${base}/healthz`);
  const text = await res.text();
  rows.push({
    check: "/healthz",
    result: text === '{"status":"ok"}' ? "PASS" : "FAIL",
    detail: text.slice(0, 80),
  });
}

// helmet / no powered-by
{
  const res = await fetch(`${base}/healthz`);
  rows.push({
    check: "X-Powered-By absent",
    result: res.headers.get("x-powered-by") ? "FAIL" : "PASS",
    detail: res.headers.get("x-powered-by") ?? "absent",
  });
}

// ---- extended checks ---------------------------------------------------------------
const policy = JSON.parse(readFileSync(resolveFromRoot("config/tool-policy.json"), "utf8"));
const allowedNames = new Set([...Object.keys(policy.allowedActions), ...policy.noActionTools]);

// tools/list: only allowlisted tools, and no blocked action is advertised
{
  const r = await rawPost(
    `/mcp/${alias}`,
    { "x-api-key": key },
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
  );
  const tools = (() => {
    try {
      return JSON.parse(r.text)?.result?.tools ?? [];
    } catch {
      return [];
    }
  })();
  const names = tools.map((t) => t.name);
  const extra = names.filter((n) => !allowedNames.has(n));
  rows.push({
    check: "tools/list only allowlisted",
    result: r.status === 200 && names.length > 0 && extra.length === 0 ? "PASS" : "FAIL",
    detail:
      r.status !== 200
        ? `HTTP ${r.status}`
        : extra.length
          ? `unexpected: ${extra.join(",")}`
          : `${names.length} tools`,
  });
  const blockedAdvertised = [];
  for (const t of tools) {
    const actions = t.inputSchema?.properties?.action?.enum;
    if (!Array.isArray(actions)) continue;
    const ok = new Set(policy.allowedActions[t.name] ?? []);
    for (const a of actions) if (!ok.has(a)) blockedAdvertised.push(`${t.name}.${a}`);
  }
  rows.push({
    check: "no blocked action advertised",
    result: blockedAdvertised.length === 0 ? "PASS" : "FAIL",
    detail: blockedAdvertised.length
      ? blockedAdvertised.join(",")
      : "none (e.g. wit_backlog.reorder hidden)",
  });
}

// explicit action allowlist: reorder, unknown action and missing action are all denied
for (const [label, name, a] of [
  ["wit_backlog.reorder denied", "wit_backlog", { action: "reorder" }],
  ["unlisted action denied", "repo_repository", { action: "brand_new_upstream_action" }],
  ["missing action denied", "repo_repository", {}],
  ["repo_create_branch blocked", "repo_create_branch", {}],
  ["wiki_upsert_page blocked", "wiki_upsert_page", {}],
]) {
  const r = await call(name, a);
  rows.push({
    check: label,
    result: toolResult(r.text)?.isError === true && /not permitted/i.test(r.text) ? "PASS" : "FAIL",
    detail: r.text.slice(0, 100).replace(/\n/g, " "),
  });
}

// errors must not leak stack traces, paths or internals
{
  const malformed = await rawPost(`/mcp/${alias}`, { "x-api-key": key }, "{not json");
  const leaks = [...bodies, malformed.text].filter((t) => LEAK.test(t));
  rows.push({
    check: "no internals in error bodies",
    result: malformed.status === 400 && leaks.length === 0 ? "PASS" : "FAIL",
    detail:
      malformed.status !== 400
        ? `malformed JSON gave HTTP ${malformed.status}`
        : leaks.length
          ? "leak pattern found"
          : "clean",
  });
}

// failed-request throttle: 20/min per (alias bucket, IP); unknown aliases share one bucket
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(base);
if (isLocal || args["test-limits"]) {
  let got429 = false;
  let retryAfter = null;
  for (let i = 0; i < 30 && !got429; i++) {
    const r = await rawPost(
      "/mcp/limit-probe-alias",
      { "x-api-key": `probe-${i}` },
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
    );
    if (r.status === 429) {
      got429 = true;
      retryAfter = r.headers.get("retry-after");
    }
  }
  rows.push({
    check: "failed-request throttle (429)",
    result: got429 && retryAfter === "60" ? "PASS" : "FAIL",
    detail: got429 ? `429 with Retry-After ${retryAfter}` : "no 429 after 30 bad requests",
  });
  const still = await rawPost(
    `/mcp/${alias}`,
    { "x-api-key": key },
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
  );
  rows.push({
    check: "throttle does not lock out the real alias",
    result: still.status === 200 ? "PASS" : "FAIL",
    detail: `HTTP ${still.status}`,
  });
} else {
  rows.push({
    check: "failed-request throttle (429)",
    result: "WARN",
    detail: "skipped on remote base; pass --test-limits to run",
  });
}

// TLS checks only for https
if (base.startsWith("https://")) {
  rows.push({
    check: "https deployed",
    result: "PASS",
    detail: "TLS endpoint (full TLS1.1 probe requires openssl; run manually if needed)",
  });
} else {
  rows.push({
    check: "tls (deployed only)",
    result: "WARN",
    detail: "skipped for non-https base",
  });
}

if (args["expect-revoked"]) {
  const r = await rawPost(
    `/mcp/${alias}`,
    { "x-api-key": String(args["expect-revoked"]) },
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
  );
  rows.push({
    check: "revoked key",
    result: r.status === 401 ? "PASS" : "FAIL",
    detail: `HTTP ${r.status}`,
  });
  console.log("");
  console.log(
    "Rotation: with A and B valid both work; remove A from Key Vault / env, then re-run with --expect-revoked <A>.",
  );
}

process.exit(resultTable(rows) ? 0 : 1);
