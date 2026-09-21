# Copilot Studio connection

## Per-org MCP server entry

| Field | Value |
|---|---|
| Server name | `ADO <alias>` (e.g. `ADO coolops`) |
| Description | Read-only Azure DevOps tools via gateway |
| URL | `https://<host>/mcp/<alias>` |
| Authentication | API key |
| Type | Header |
| Header name | `X-API-Key` |
| Header value | Value of `mcp-<alias>-key-a` (from Key Vault) |

## Agent settings

- Generative orchestration: **on**
- Keep the tool list small (gateway already default-denies writes)
- Suggested instructions: use small `top` values; call `core_list_projects` first

## Test plan

1. Maker test pane: list projects.
2. Activity map shows `tools/call` to the gateway.
3. **Second user** (non-maker) in Teams/web: confirm whether they are prompted for the API key. Decide shared maker connection vs future OAuth.

## Behaviors to verify

- Key for org A fails on org B URL.
- Write tools are not listed / calls fail.
- Empty wiki/repo lists are acceptable; 401/403 map to missing ADO permissions (see `verify:org`).
