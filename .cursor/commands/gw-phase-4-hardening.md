# Phase 4: hardening and observability

Read first: `10-architecture.mdc`, `20-verification.mdc`, `50-traps.mdc`.

Tasks
1. Limits: JSON body max 256 KB (413); per-alias rate limit (`limits.ratePerMinute`, default 120, 429 with `Retry-After`); failed-auth limiter per client IP (20 per minute, 429); `MAX_CONCURRENT_CHILDREN` default 6 with a bounded wait queue (10 s, then a clean "busy" tool error); overall per-request deadline. Set `trust proxy` deliberately for the Azure front end and test it.
2. Security headers via helmet, no `X-Powered-By`, no CORS headers, `Cache-Control: no-store`.
3. Logging with pino JSON to stdout: `ts, level, requestId, alias, method (initialize|tools/list|tools/call), tool, actionArg, argKeys, project (if present), durationMs, outcome, httpStatus, responseChars, truncated`. Redact headers and any key named like `pat|token|secret|key|authorization|password`. Never log tool result bodies. Include `requestId` in error responses. Optional Application Insights via `APPLICATIONINSIGHTS_CONNECTION_STRING`.
4. `GET /healthz` returns 200 `{"status":"ok"}` and nothing else. `GET /readyz` checks registry loaded and Key Vault reachable; it returns a bare 200/503, and per-alias booleans only with a valid `X-Admin-Key` (a Key Vault secret `mcp-admin-key`).
5. Graceful shutdown: on SIGTERM stop accepting, finish in-flight (max 20 s), kill children, exit 0. Never write under the app directory at runtime (Run-From-Package is read-only); use `os.tmpdir()`.

Accept
- Tests for each limit; the log-redaction sentinel test across all code paths; concurrency-cap test with a slow fake child; shutdown test; process-leak test (child count returns to baseline).

Then run `/gw-verify` and stop.
