#!/usr/bin/env node
/**
 * Build a deployable zip on Linux x64 only. Windows/macOS require --dry-run (NOT DEPLOYABLE).
 */
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./verify/_lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const platform = process.platform;

if (platform !== "linux" && !dryRun) {
  console.error(
    `REFUSED: package.mjs builds only on Linux x64 (got ${platform}). Pass --dry-run for a local NOT DEPLOYABLE stamp.`,
  );
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = runCommand(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (${r.error?.message ?? `exit ${r.status}`})`,
    );
  }
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version ?? "0.0.0";
let gitsha = "nogit";
{
  const r = runCommand("git", ["rev-parse", "--short", "HEAD"], { cwd: root });
  if (r.status === 0 && r.stdout) gitsha = r.stdout.trim();
}

const stamp = dryRun || platform !== "linux" ? "NOT-DEPLOYABLE" : gitsha;
const outName = `gateway-${version}-${stamp}.zip`;
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const staging = path.join(artifacts, "staging");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

console.log(`Packaging ${outName} (platform=${platform}, dryRun=${dryRun})`);

if (!dryRun) {
  run("npm", ["ci"]);
  run("npm", ["run", "build"]);
  run("npm", ["test"]);
} else {
  // Dry-run: build if possible, still produce stamped artifact tree
  try {
    run("npm", ["run", "build"]);
  } catch {
    console.warn("build skipped/failed in dry-run; continuing with whatever is present");
  }
}

// Production node_modules in staging
cpSync(path.join(root, "package.json"), path.join(staging, "package.json"));
cpSync(path.join(root, "package-lock.json"), path.join(staging, "package-lock.json"));
run("npm", ["ci", "--omit=dev"], { cwd: staging });

mkdirSync(path.join(staging, "dist"), { recursive: true });
mkdirSync(path.join(staging, "config"), { recursive: true });
cpSync(path.join(root, "dist"), path.join(staging, "dist"), { recursive: true });
cpSync(path.join(root, "config", "orgs.json"), path.join(staging, "config", "orgs.json"));
// tool-policy.json is REQUIRED at runtime (src/ado/toolPolicy.ts). The snapshot is for verify:drift.
for (const f of ["tool-policy.json", "tool-snapshot.json"]) {
  cpSync(path.join(root, "config", f), path.join(staging, "config", f));
}

if (dryRun || platform !== "linux") {
  writeFileSync(
    path.join(staging, "NOT_DEPLOYABLE.txt"),
    "This package was built with --dry-run or on a non-Linux host. Do not deploy.\n",
    "utf8",
  );
}

// Minimal zip without external deps: store files with local file headers (store method)
const zipPath = path.join(artifacts, outName);
await zipDirectory(staging, zipPath);

const sha = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
writeFileSync(`${zipPath}.sha256`, `${sha}  ${outName}\n`, "utf8");

const sizeMb = (statSync(zipPath).size / (1024 * 1024)).toFixed(1);
console.log(`Wrote ${zipPath} (${sizeMb} MB)`);
console.log(`SHA256 ${sha}`);
if (dryRun || platform !== "linux") {
  console.log("STAMP: NOT DEPLOYABLE");
}

/**
 * Minimal zip writer with no external dependencies: deflate-compressed entries,
 * forward-slash paths, sorted (stable) order, fixed timestamps, Unix modes preserved.
 */
async function zipDirectory(dir, outFile) {
  const files = [];
  function walk(current, prefix) {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else files.push({ full, name: rel, mode: st.mode & 0o777 });
    }
  }
  walk(dir, "");

  const { openSync, writeSync, closeSync } = await import("node:fs");
  const { deflateRawSync } = await import("node:zlib");
  const fd = openSync(outFile, "w");
  const central = [];
  let offset = 0;

  const u16 = (n) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n, 0);
    return b;
  };
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
  };

  const DOS_TIME = 0;
  const DOS_DATE = 0x0021; // 1980-01-01, keeps the archive reproducible
  const FLAG_UTF8 = 0x0800;

  for (const f of files) {
    const data = readFileSync(f.full);
    const packed = deflateRawSync(data, { level: 9 });
    const useDeflate = packed.length < data.length;
    const body = useDeflate ? packed : data;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(data);

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(FLAG_UTF8),
      u16(method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(body.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
    ]);
    writeSync(fd, localHeader);
    writeSync(fd, body);
    central.push({
      nameBuf,
      crc,
      method,
      csize: body.length,
      size: data.length,
      offset,
      attr: ((0o100000 | f.mode) << 16) >>> 0,
    });
    offset += localHeader.length + body.length;
  }

  const centralStart = offset;
  for (const c of central) {
    const hdr = Buffer.concat([
      u32(0x02014b50),
      u16((3 << 8) | 20), // made by: Unix, spec 2.0
      u16(20),
      u16(FLAG_UTF8),
      u16(c.method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(c.crc),
      u32(c.csize),
      u32(c.size),
      u16(c.nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(c.attr),
      u32(c.offset),
      c.nameBuf,
    ]);
    writeSync(fd, hdr);
    offset += hdr.length;
  }
  const centralSize = offset - centralStart;
  writeSync(
    fd,
    Buffer.concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(central.length),
      u16(central.length),
      u32(centralSize),
      u32(centralStart),
      u16(0),
    ]),
  );
  closeSync(fd);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c >>> 0;
}
