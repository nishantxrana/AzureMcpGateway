# Runbook

## Rotate a client API key (A/B)

1. Create `mcp-<alias>-key-b` in Key Vault (if missing): `openssl rand -hex 32` then `az keyvault secret set ...`
2. Ensure registry `clientKeys` lists both `key-a` and `key-b`.
3. Wait up to 5 minutes for the secret cache (keys are re-read per request, no restart needed) and confirm both keys work: `verify:security`.
4. Update Copilot Studio to key-b.
5. Remove key-a from Key Vault (or overwrite with random junk). Re-run `verify:security --expect-revoked <old-a>`.

## Rotate a PAT

1. As the **service account**, create a new **org-scoped** read-only PAT.
2. `az keyvault secret set --vault-name <vault> --name ado-<alias>-pat --value "$(read -rs -p 'PAT: ' v; echo "$v")"`
3. Wait ≤5 minutes; run `verify:org`.
4. Revoke the old PAT in ADO **first** if it leaked; otherwise revoke after confirm.

## Rotate a service-principal secret

1. Create a new client secret in Entra.
2. Store as `ado-<alias>-sp-secret` in Key Vault.
3. Confirm `verify:org`; delete the old Entra secret.

## Add / remove an org

- Add: `node scripts/onboard-org.mjs --alias ... --org ... --auth pat --domains ...` then Key Vault secrets, PR `config/orgs.json`, deploy, `verify:org`.
- Remove: delete registry entry (PR), deploy, delete Key Vault secrets, remove Copilot Studio entry.

## Upgrade `@azure-devops/mcp`

1. Bump pin in `package.json` (keep exact version).
2. `npm run verify:drift` (or `--update` after review).
3. If `verify:drift` reports an unreviewed action, read what it does. Read-only: add it to `allowedActions` in `config/tool-policy.json`. Anything that changes data: add it to `reviewedBlockedActions`. Then `npm run verify:drift -- --update` and review the snapshot diff.
4. Deploy to staging; `verify:security` + `verify:org`.

## Leaked key / PAT

- Key: rotate immediately (A/B). PAT: **revoke in ADO first**, then rotate Key Vault.

## Logs (Log Analytics)

```kusto
AppServiceConsoleLogs
| where TimeGenerated > ago(1h)
| where ResultDescription has "mcp"
| project TimeGenerated, ResultDescription
```

Never search for raw key/PAT values in tickets.

## Roll back

- With slot: swap staging ↔ production again.
- Without slot: redeploy previous pipeline artifact zip (`az webapp deploy --src-path <old.zip>`).
