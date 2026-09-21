# Infrastructure (Bicep)

Deploys Log Analytics, Application Insights, Key Vault (RBAC + purge protection), and a Linux App Service (Node 22) with optional staging slot.

## Prerequisites

- Azure CLI + Bicep (`az bicep install`)
- Contributor + User Access Administrator (or Owner) on the resource group
- After deploy, grant yourself **Key Vault Secrets Officer** on the vault (manual; not in Bicep)

## What-if then create

```bash
az group create --name rg-adomcp-dev --location centralindia

az deployment group what-if \
  --resource-group rg-adomcp-dev \
  --template-file infra/main.bicep \
  --parameters infra/main.parameters.example.json

az deployment group create \
  --resource-group rg-adomcp-dev \
  --template-file infra/main.bicep \
  --parameters infra/main.parameters.example.json
```

## Alerts

Set the `alertEmail` parameter (in your parameters file) to create an action group. Without it the alerts (5xx, health check, 401 spike) are created but notify nobody. Not created: a restart-count alert.

## App settings (no secrets)

Only: `KEY_VAULT_URI`, `NODE_ENV`, `ORG_REGISTRY_PATH`, `CHILD_TIMEOUT_MS`, `MAX_CONCURRENT_CHILDREN`, `APPLICATIONINSIGHTS_CONNECTION_STRING`, `WEBSITE_RUN_FROM_PACKAGE`, `SCM_DO_BUILD_DURING_DEPLOYMENT`.

## Bootstrap path (non-production)

First manual deploy only: set `SCM_DO_BUILD_DURING_DEPLOYMENT=true` and deploy a source zip **without** `node_modules` so Oryx builds on the server. Downsides: less reproducible, slower, can pick wrong native binaries. Prefer the Linux CI zip + Run-From-Package path.

## Network hardening

Do **not** enable IP restrictions by default. Copilot Studio calls originate from Microsoft infrastructure with changing IPs; test from a real agent on a staging slot first.
