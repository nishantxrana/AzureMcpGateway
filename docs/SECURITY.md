# Security

## Threat model

| Asset | Threat | Control | Proof |
|---|---|---|---|
| Client API key | Leak / reuse across orgs | Per-alias keys; uniform 401; Key Vault | `verify:security`, auth tests |
| PAT / SP secret | Leak via logs or app settings | Never in app settings; redaction; EnvSecretProvider banned in prod | log sentinel tests, `verify:azure` |
| Prompt injection via ADO text | Agent follows ticket/PR text | UNTRUSTED envelope preserved; read-only tools; allowlist | shaping tests, policy tests |
| Tool drift after upgrade | New write tool or write-like action appears (for example `wit_backlog.reorder`) | Default-deny tools + explicit per-tool action allowlist (`config/tool-policy.json`); `extraAllow` cannot enable write-named tools; `verify:drift` fails on unreviewed actions | `toolPolicy` tests, `verify:drift`, `verify:security` |
| Alias enumeration / key guessing | Probe aliases, brute-force keys | Identical 401 for unknown/missing/wrong; failed requests limited to 20/min per (alias, IP) and checked BEFORE the key, so a correct guess past the limit is still refused; all unknown aliases share one limiter bucket | auth tests, `verify:security` |
| SSRF | User-controlled URLs | Fixed ADO host in official server; no user URLs | design |
| DoS | Flood / huge bodies | Body 256KB, rate limits, child concurrency | hardening tests |
| Log leakage | Secrets in stdout | pino redact; no result bodies | sentinel tests |
| Supply chain | Bad package / wrong arch | Pin lockfile, npm audit, Linux ELF check | `verify:package` |
| Key Vault compromise | Blast radius | Per-org secrets; RBAC Secrets User only on MI | Bicep |
| Cross-org bleed | Wrong credentials | Per-request child env; isolation tests | integration tests |

## Residual risks (known)

- **Shared service identity:** every user of a Copilot Studio agent sees whatever the org PAT/SP can see in ADO. Least privilege is enforced in ADO project memberships, not per end-user.
- **Copilot Studio API-key connection scope:** Microsoft's material describes connections as user-scoped; end users may be prompted for the key. Test with a second account before rollout.
- **Global PATs** stop working **2026-12-01**. Org-scoped PATs only.
- **A known alias whose client keys cannot be loaded answers 503, not 401.** This reveals that the alias exists (aliases are not treated as secret). Fixing it would hide a real outage from operators.
- **The failed-request limiter is per source IP.** Copilot Studio calls come from shared Microsoft addresses, so a badly misconfigured client could briefly throttle other callers on the same address for that alias. The limit is 20 failed requests per minute.
- **Rotation latency:** a rotated or revoked client key takes effect within the Key Vault cache TTL (5 minutes), not instantly. Restart the app to force it.
- **Error text:** anything not written by the gateway itself is replaced by a generic message with a `requestId`; the detail is only in the server log.

## Known limitations

- No per-user OAuth on-behalf-of yet (authenticator interface is ready).
- `tools/list` warm uses a real child spawn; cold start of an alias can take ~0.5s.
- Response shaping is best-effort on non-JSON / non-envelope payloads (pass-through + size cap).
