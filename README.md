# ADO MCP Gateway

Multi-organization Azure DevOps MCP gateway for Microsoft Copilot Studio. One App Service deployment; per-org routes, keys, and credentials in Key Vault.

## Quick start (local)

```bash
cd "/c/Users/nishant.rana/Documents/Agents/The Archivist/Cursor-mcp"
cp .env.example .env.local   # fill SECRET__* values; never commit
npm ci
npm run build
npm test
npm run verify:local
npm run dev
```

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Runbook](docs/RUNBOOK.md)
- [Onboard org](docs/ONBOARD-NEW-ORG.md)
- [Copilot Studio](docs/COPILOT-STUDIO.md)
- [Prerequisites](PREREQUISITES.md)
- [Infra](infra/README.md)

## Cursor kit

Slash commands and rules live under `.cursor/` (never shipped in the deploy zip).
