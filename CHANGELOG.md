# Changelog

## 0.1.1

Security
- Tool policy is now an explicit per-tool **action allowlist** (`config/tool-policy.json`). `wit_backlog.reorder` (a write) was reachable before; unknown, new and missing actions are now rejected, and the action enum shown to the model is narrowed. `extraAllow` can no longer enable write-named tools.
- Failed-auth throttling now runs **before** the key check (a correct guess past the limit is refused). Unknown aliases share one limiter bucket, fixing unbounded memory growth. Auth runs before the body is parsed.
- Error text not written by the gateway is replaced with a generic message plus `requestId` (no paths or upstream text). `/readyz` admin key compared in constant time.
- Client disconnect now aborts the child process.

Fixes
- A missing spare key (`key-b`) no longer marks the whole alias unhealthy (it returned 503 forever). Client keys are read per request, so rotation needs no restart, as documented.
- `verify:*` and `package` scripts failed on Windows with `exit null` (`.cmd` shims). All external commands go through `runCommand`. `verify:local` now continues past a failed step and shows spawn errors.
- ESLint now knows the Node globals used by the test fixture.
- `config/tool-snapshot.json` regenerated from the real server (it held guessed actions). `verify:drift` now checks policy against the live server.
- `package.mjs` did not ship `config/tool-policy.json` (the deployed app would not start). Zip is now deflate-compressed (34 MB, was 116 MB) with stable timestamps and preserved modes.
- `verify:package`: real smoke start; other-platform prebuilds no longer fail the ELF check.
- `verify:org` probes now use a real project and only pass on clean results; `verify:security` gained tools/list, `reorder`, error-leak and throttle checks; `verify:soak` no longer crashes when the gateway is unreachable.
- `onboard-org.mjs` validates with the gateway's own schema before writing (it previously wrote invalid aliases and then blocked on a prompt).

Added
- `azure-pipelines.yml` (build, test, package, staging slot, verify, approval, swap, swap-back).
- Bicep: alert notification action group (`alertEmail`), health-check alert, 401-spike alert; corrected 5xx alert description.
- `QUEUE_TIMEOUT_MS` setting; `rawChars` in tool-call logs.
- Tests: 48 -> 74 (busy path, hang/crash/garbage children, key rotation, brute-force throttle, policy, Windows launch behaviour).

## 0.1.0

- Initial multi-org ADO MCP Gateway: registry, Key Vault/env secrets, Streamable HTTP bridge, default-deny tool policy, response shaping, hardening, verification scripts, Bicep, zip deploy (no Docker).
- Legacy single-org `mcp-proxy` wrapper retained under `legacy/` until live parity is confirmed.
