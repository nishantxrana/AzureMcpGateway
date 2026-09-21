# Architecture

## Diagram

```
Copilot Studio agent (one MCP entry per org)
   POST https://<gateway>/mcp/<alias>   header: X-API-Key
        |
+--------------------------------------------------------------+
| Gateway (Node 22, Express 5, Streamable HTTP, stateless)     |
|  auth → rate limit → tools/list (cache) / tools/call (spawn) |
|  shape → audit log                                           |
+--------------------------------------------------------------+
        | stdio                         | managed identity
   @azure-devops/mcp@2.10.0        Azure Key Vault
        | HTTPS
   dev.azure.com/<org>
```

## Request lifecycle

1. Authenticate alias + `X-API-Key` (SHA-256 + `timingSafeEqual`). Unknown alias / missing / wrong key → identical 401.
2. Missing secrets for an alias → 503 for that alias only.
3. `tools/list`: filtered by default-deny allowlist; cached 15 minutes per alias.
4. `tools/call`: tool allowlist + explicit per-tool action allowlist (`config/tool-policy.json`) + mutation-verb regex → spawn stdio child with minimal env + org credentials → shape response → audit log.
5. Child timeout (`CHILD_TIMEOUT_MS`) and concurrency cap (`MAX_CONCURRENT_CHILDREN`).

## Design decisions

See `.cursor/rules/10-architecture.mdc` decision table (custom bridge vs mcp-proxy, spawn-per-call, Key Vault by name, zip deploy on Linux, uniform 401).

## Failure modes

| Failure | Client sees | Recovery |
|---|---|---|
| Wrong API key | Identical 401 | Rotate / use key-b |
| Missing org secret | 503 for that alias | Put secret in Key Vault |
| Child hang | Tool error after timeout | Automatic kill + reap |
| Upstream ADO 401/203 HTML | Tool error (no body leak) | Fix PAT scopes / identity |
| Tool drift after upgrade | CI `verify:drift` fails | Review the new action, then add it to `allowedActions` or `reviewedBlockedActions` in `config/tool-policy.json` and refresh the snapshot |

## Runtime

- Target: App Service Linux `NODE|22-lts`, `appCommandLine: node dist/index.js`, listen on `PORT`.
- Fallback: `NODE|20-lts` only if 22 is unavailable in region (record here if used). **Current decision: Node 22.**

## Non-goals

UI, write tools, per-user OBO OAuth (seam only), database, session state, containers/Docker.
