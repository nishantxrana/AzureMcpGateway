# Phase 2: gateway core (port and harden the spike)

Read first: `10-architecture.mdc`, `20-verification.mdc`, `50-traps.mdc`, and `.cursor/kit/reference/gateway-spike.mjs` plus `spike-test.mjs`.

Tasks
1. Port the spike into the layout in `10-architecture.mdc`. Make the child command overridable with `ADO_MCP_BIN` so tests use `test/fixtures/fake-ado-mcp.mjs` (write that fake stdio MCP server with the SDK; it mimics tool names, an `action` enum, the UNTRUSTED envelope, and can be told to crash, hang, or print garbage).
2. Routes: `POST /mcp/:alias` only. `GET|DELETE /mcp/:alias` return a 405 JSON-RPC error. Everything else is a generic 404.
3. `ApiKeyAuthenticator`: header `X-API-Key`; compare SHA-256 digests with `timingSafeEqual`; accept either of the alias's 1 or 2 keys; **identical 401** for unknown alias, missing header and wrong key (do a dummy compare for unknown aliases to even out timing).
4. `AdoCredentialStrategy`: `pat` (env `PERSONAL_ACCESS_TOKEN = base64("mcp:" + pat)`, args `--authentication pat`) and `entra-sp` (env `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, args `--authentication env`).
5. `child.ts`: spawn with `process.execPath`, no shell, explicit minimal env (`PATH`, a temp `HOME`, plus credential vars). Capture stderr, truncate, debug-log only. Kill on timeout (`CHILD_TIMEOUT_MS`, default 60000) with SIGKILL after a 2 s grace. Always reap the child, even if the HTTP client disconnects.
6. `tools/list`: computed once per alias (lazy, warmed at startup without failing), cached 15 minutes, filtered by policy. `initialize` returns `serverInfo` named `ado-gateway/<alias>` and the alias's optional `instructions`.

Accept
- Integration tests (real HTTP, fake child): routing, uniform 401, key rotation (both keys work; removing one blocks it), alias isolation, 405s, child env isolation, child reaped after success, error, timeout and client abort.
- **Parity check** with the real official server and the real org: `core_list_projects` through the gateway returns the same projects as `legacy/start.mjs`. I will run this one myself with my credentials; prepare a script `scripts/parity.mjs` and tell me how to run it.
- Only after I confirm parity: delete `legacy/`.

Then run `/gw-verify` and stop.
