# Phase 1: registry and secrets

Read first: `10-architecture.mdc` (registry schema, secret names), `20-verification.mdc` (test matrix: registry and secrets, logging), `50-traps.mdc`.

Tasks

1. `src/config/registry.ts`: zod schema exactly as specified, `loadRegistry(path)`, precise error messages, exported JSON Schema to `config/orgs.schema.json`. Ship `config/orgs.example.json` and a `config/orgs.json` containing one org (`coolops`) with placeholder-free but non-secret content.
2. `src/secrets/provider.ts` interface. `EnvSecretProvider` reads `SECRET__<NAME_UPPER_SNAKE>` (local and tests only; refuse to construct when `NODE_ENV=production`). `KeyVaultSecretProvider` uses `KEY_VAULT_URI` and `DefaultAzureCredential`, 5 min TTL cache, 30 s negative cache, never logs values.
3. `src/config/env.ts`: typed env parsing with zod.
4. Startup behavior: invalid registry means fail fast with a precise message. A missing secret for one alias marks only that alias unhealthy (its requests get a generic 503 and `/readyz` reports it). Other aliases keep working.

Accept

- Unit tests for every validation rule, duplicate aliases, unknown fields, cache TTL and negative cache, missing-secret isolation.
- A test proving no secret value appears in any log line produced while loading (sentinel test).

Then run `/gw-verify` and stop.
