#!/usr/bin/env node
/**
 * verify:soak — concurrency / latency hammer for tools/list + one cheap tools/call.
 */
import {
  nodeMajorOk,
  parseArgs,
  printHelp,
  preflight,
  resultTable,
} from "./_lib.mjs";

const args = parseArgs();
if (args.help || !args.base || !args.alias || !args.key) {
  printHelp(
    "verify:soak",
    "node scripts/verify/soak.mjs -- --base <url> --alias <a> --key <k> [--seconds 60] [--concurrency 12]",
    {
      base: "Gateway base URL",
      alias: "Alias",
      key: "API key",
      seconds: "Duration (default 60)",
      concurrency: "Parallel workers (default 12)",
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
const seconds = Number(args.seconds ?? 60);
const concurrency = Number(args.concurrency ?? 12);

async function once(method, params) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/mcp/${alias}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-api-key": key,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    return { status: res.status, ms: Date.now() - t0, text, netError: null };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, text: "", netError: e instanceof Error ? e.message : String(e) };
  }
}

const latencies = [];
let errors5xx = 0;
let netErrors = 0;
let throttled = 0;
let busy = 0;
let toolErrors = 0;
let okCount = 0;
let firstNetError = "";
const deadline = Date.now() + seconds * 1000;

function record(r, { isCall }) {
  latencies.push(r.ms);
  if (r.netError) {
    netErrors++;
    firstNetError ||= r.netError;
  } else if (r.status === 429) throttled++;
  else if (r.status >= 500) errors5xx++;
  else if (isCall && /"isError":true/.test(r.text)) {
    if (/Gateway busy/i.test(r.text)) busy++;
    else toolErrors++;
  } else okCount++;
}

async function worker() {
  while (Date.now() < deadline) {
    record(await once("tools/list", {}), { isCall: false });
    record(await once("tools/call", { name: "core_list_projects", arguments: {} }), { isCall: true });
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
latencies.sort((a, b) => a - b);
const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

const rows = [
  {
    check: "gateway reachable",
    result: netErrors === 0 ? "PASS" : "FAIL",
    detail: netErrors === 0 ? "no network errors" : `${netErrors} network errors, first: ${firstNetError.slice(0, 120)}`,
  },
  {
    check: "no unexpected 5xx",
    result: errors5xx === 0 ? "PASS" : "FAIL",
    detail: `${errors5xx} unexpected 5xx`,
  },
  {
    check: "no non-busy tool errors",
    result: toolErrors === 0 ? "PASS" : "FAIL",
    detail: `${toolErrors} tool errors (a deliberate "Gateway busy" is not counted)`,
  },
  {
    check: "rate limiting",
    result: throttled === 0 ? "PASS" : "WARN",
    detail:
      throttled === 0
        ? "no 429s"
        : `${throttled} requests got 429; the run measured the limiter, not capacity. Lower --concurrency or use a test alias with a higher ratePerMinute`,
  },
  { check: "busy (concurrency cap)", result: "PASS", detail: `${busy} clean busy responses` },
  { check: "p95 latency", result: "PASS", detail: `${p95}ms over ${latencies.length} samples` },
  { check: "completed ops", result: okCount > 0 ? "PASS" : "FAIL", detail: String(okCount) },
];

process.exit(resultTable(rows) ? 0 : 1);
