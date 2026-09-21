# Onboard a new ADO org

End-to-end using `scripts/onboard-org.mjs`.

## 1. ADO prerequisites

- Service account (not a person) with **Basic** access.
- Member of **Readers** on each project the agent may see.
- **Org-scoped** read-only PAT (Code, Build, Work Items, Wiki, Project and Team as needed). Global PATs die 2026-12-01.
- Or: Entra app + SP in the **same tenant** the org is connected to.

## 2. Registry + Key Vault

```bash
cd "/c/Users/nishant.rana/Documents/Agents/The Archivist/Cursor-mcp"
node scripts/onboard-org.mjs --alias acme --org acme-devops --auth pat --domains core,repositories,pipelines,work-items,wiki
```

Follow printed `az keyvault secret set` commands (hidden `read`). Also ensure `mcp-admin-key` exists for `/readyz` detail.

## 3. PR and deploy

- Open a PR for `config/orgs.json`.
- Pipeline builds the Linux zip, deploys staging, runs verifications.
- Approve production swap.

## 4. Verify

```bash
npm run verify:org -- --base https://<host> --alias acme --key "$KEY"
```

## 5. Copilot Studio

See [COPILOT-STUDIO.md](./COPILOT-STUDIO.md).
