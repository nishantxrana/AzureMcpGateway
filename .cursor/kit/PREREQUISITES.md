# Prerequisites: what must be true before you run any script

Work top to bottom. Each section ends with a check. Do not skip A: it decides the design.

---

## A. Decisions to make first (10 minutes)

| Decision                               | Recommended                                                                                                              | Why                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| ADO org name spelling                  | Exactly what appears in `https://dev.azure.com/<name>`. Your output showed `coolops` (an earlier message said `coolosp`) | A typo gives confusing 401/404 errors                                |
| Alias per org                          | Short lowercase, e.g. `coolops`                                                                                          | Becomes the URL path `/mcp/<alias>` and part of secret names         |
| Identity type per org                  | **PAT from a dedicated service account** now; **service principal** if the org is Entra-backed and you have admin rights | PATs are simplest. Microsoft recommends Entra-based auth             |
| Are all your orgs in ONE Entra tenant? | Find out (Organization settings > Microsoft Entra)                                                                       | Service principals only work from the tenant the org is connected to |
| Azure region and plan SKU              | A region near you (e.g. Central India). `B1` for dev, `P0v3` or `S1` for anything with a staging slot                    | **Staging slots need Standard tier or higher. `B1` has no slots**    |
| Names                                  | `rg-adomcp-<env>`, `kv-adomcp-<env>-<suffix>`, `app-adomcp-<env>`                                                        | Key Vault names must be globally unique                              |

**Important date:** global PATs (created for "All accessible organizations") stop working on **2026-12-01**. Every PAT you create for this must be scoped to **one specific organization**.

---

## B. Azure DevOps side (do this for EACH org)

1. **Confirm org and tenant.** Organization settings > Microsoft Entra. Note whether it is connected and to which tenant ID.
2. **Create a dedicated service account** (a normal Entra user such as `svc-adomcp@yourdomain`, not a person's account) with **Basic** access. A PAT acts as its owner; a person's PAT breaks when they leave and usually over-exposes.
3. **Grant only what it must read.** Add it to the **Readers** group of each project the agent may see. Not Contributors. This is your real least-privilege control: the gateway cannot show data the identity cannot see.
4. **Create the PAT while signed in as the service account:**
   - Organization: the **specific org** (not "All accessible organizations")
   - Expiry: 90 days or less, with a calendar reminder 2 weeks earlier
   - Scopes (custom defined), all **Read** only, and only for domains you enable: **Code**, **Build**, **Work Items**, **Wiki**, **Project and Team**
   - Scope names are as shown on the token screen. If `verify:org` later reports 401 for a domain, add that domain's Read scope.
5. **If you use a service principal instead:**
   - Register an app in the **same tenant the ADO org is connected to**
   - Create a client secret and store it straight into Key Vault
   - In ADO: Organization settings > Users > Add users, enter the service principal (use the object ID from **Enterprise applications**, not the app registration), access level Basic, then add it to the Readers group of the needed projects
   - A service principal may count as a billable user; check your billing
6. **Check organization policies** (Organization settings > Policies and Security): PAT creation and any third-party access settings must not be blocked for the service account. If your tenant admin restricts PATs, use the service principal route.
7. **Turn on auditing** (Organization settings > Auditing) if available for your org.

**Check:** sign in as the service account; it can open a project's Repos, Pipelines and Wiki but cannot edit anything.

---

## C. Azure side (one time)

1. **Subscription and rights.** `Contributor` plus `User Access Administrator` (or `Owner`) on the target resource group, because deployment creates role assignments.
2. **Resource providers registered:** `Microsoft.Web`, `Microsoft.KeyVault`, `Microsoft.Insights`, `Microsoft.OperationalInsights`. (`az provider register --namespace <name>`)
3. **Tools:** Azure CLI (recent) and Bicep (`az bicep install`); `az login` to the right tenant and `az account set` to the right subscription.
4. **Runtime availability.** Run `az webapp list-runtimes --os linux` and confirm `NODE|22-lts` is listed in your region. If not, the fallback is `NODE|20-lts`.
5. **Key Vault access for you.** After deployment grant yourself **Key Vault Secrets Officer** on the vault to create secrets. The web app identity gets **Key Vault Secrets User** (Bicep does this).
6. **Budget alert** on the resource group.
7. **Decide who can read logs** (Log Analytics workspace access).

**Check:** `az account show` shows the right subscription; `az group create` and `az role assignment list` work for you.

---

## D. Which tenant is which (write this down)

| Thing                                       | Tenant |
| ------------------------------------------- | ------ |
| Azure DevOps org(s)                         | ______ |
| Azure subscription (App Service, Key Vault) | ______ |
| Power Platform / Copilot Studio environment | ______ |

- PAT-based access works regardless of how these differ.
- Service principal or managed identity access needs the identity in the **ADO org's tenant** (or the documented federated-credential workaround).
- Copilot Studio only calls your gateway URL with a key, so its tenant does not need to match anything.

---

## E. Copilot Studio / Power Platform side

1. You can create agents and connections in the target environment.
2. **Generative orchestration is on** for the agent (MCP tools are ignored otherwise).
3. **DLP policy:** ask your Power Platform admin whether data policies block custom connectors or MCP servers in this environment. A block shows up as a connection that cannot be created.
4. **One MCP server entry per org**, each with its own URL (`https://<host>/mcp/<alias>`) and its own API key. Never reuse a key across orgs.
5. **Test with a second user.** Microsoft's material describes API-key connections as user-scoped, so end users may be prompted for the key. Test with a non-maker account in your real channel (Teams or web) before rollout. If end users are prompted, decide between a shared connection under maker credentials (if your tenant offers it) or moving to OAuth 2.0 later.
6. Keep each agent's enabled tool list small.

**Check:** in the test pane the agent lists projects through the gateway and the activity map shows the tool call.

---

## F. Your machine

- Node.js **22 LTS**, npm, Git
- Azure CLI and Bicep
- Cursor (recent version, so `/` commands work)
- Optional: `gitleaks`, `jq`
- Windows: use **Git Bash**. Your project path contains a space (`The Archivist`), so quote paths: `cd "/c/Users/<you>/Documents/Agents/The Archivist/<repo>"`
- Line endings: the repo will contain `.gitattributes` forcing LF. Make sure `git config core.autocrlf` is not rewriting scripts.
- **No Docker needed.**
- **Do not deploy anything built on this Windows machine.** The deployment zip must be built by the pipeline on a Linux agent, because `node_modules` contains platform-specific native binaries. Local builds are for development only.

**Check:** `node -v` prints v22.x and `az version` works.

---

## G. Secrets inventory (create these; never put values in git, chat or app settings)

| Secret name (Key Vault) | What                                            | Who creates                  | Rotation             |
| ----------------------- | ----------------------------------------------- | ---------------------------- | -------------------- |
| `ado-<alias>-pat`       | Org-scoped read-only PAT of the service account | ADO admin                    | 90 days              |
| `ado-<alias>-sp-secret` | Service principal secret (only if using SP)     | Entra admin                  | 6 to 12 months       |
| `mcp-<alias>-key-a`     | Client API key for Copilot Studio               | You (`openssl rand -hex 32`) | 90 days              |
| `mcp-<alias>-key-b`     | Spare key for zero-downtime rotation            | You                          | Only during rotation |
| `mcp-admin-key`         | Key for the detailed `/readyz` view             | You                          | 90 days              |

Set a secret without leaving the value in shell history:

```
az keyvault secret set --vault-name <vault> --name ado-<alias>-pat --value "$(read -rs -p 'PAT: ' v; echo "$v")"
```

For **local** verification use an untracked `.env.local` (Cursor generates `.env.example`). Never commit it.

If a real PAT or key has ever been pasted into a chat, ticket or screenshot, revoke it and create a new one before deploying.

---

## H. Azure DevOps pipeline prerequisites (for CI/CD)

1. A project and repo in ADO holding this code, with **branch policy** on `main` (PR required, build validation).
2. An **Azure Resource Manager service connection** using **workload identity federation**, scoped to the resource group, allowed to deploy to the web app (and its slot).
3. That pipeline identity needs **Key Vault Secrets User** on the vault, so verification steps read keys at run time instead of using pipeline variables.
4. An **Environment** named `production` with an **approval check**.
5. **Microsoft-hosted `ubuntu-latest` agents** available to your org (the package must be built on Linux x64).

---

## I. Order of operations (which script runs when)

| Step | Action                                          | Script / command                                            | Needs                |
| ---- | ----------------------------------------------- | ----------------------------------------------------------- | -------------------- |
| 1    | Decisions and tenant map                        | sections A and D                                            | none                 |
| 2    | Create service account, PAT (or SP) per org     | section B                                                   | ADO admin            |
| 3    | Local tooling                                   | section F                                                   | none                 |
| 4    | Build with Cursor, phase by phase               | `/gw-plan`, then `/gw-phase-N-*`                            | none                 |
| 5    | Local proof, no Azure                           | `verify:local`, `verify:drift`, `verify:secrets`            | Node only            |
| 6    | Local proof against real ADO                    | `verify:org` (local gateway, `.env.local`) and `parity.mjs` | PAT                  |
| 7    | Deploy infrastructure                           | `az deployment group what-if`, then `create`                | section C            |
| 8    | Put secrets into Key Vault                      | section G                                                   | Secrets Officer role |
| 9    | Azure configuration audit                       | `verify:azure`                                              | `az` login           |
| 10   | Pipeline builds and validates the zip on Linux  | `package.mjs`, `verify:package`                             | section H            |
| 11   | Deploy to **staging slot** (or directly in dev) | pipeline stage 3                                            | secrets in place     |
| 12   | Security and live checks on staging             | `verify:security`, `verify:org`, `verify:soak`              | keys, PAT            |
| 13   | Approve and swap to production                  | pipeline approval                                           | step 12 all green    |
| 14   | Connect Copilot Studio                          | `docs/COPILOT-STUDIO.md`                                    | section E            |
| 15   | Test with a second user                         | section E.5                                                 | second account       |

---

## J. Go / no-go before real data goes through it

- [ ] Every PAT is organization-scoped, read-only, from a service account, with an expiry reminder in the calendar
- [ ] The service account is only a Reader on the projects the agent should see
- [ ] All secrets are in Key Vault; `verify:azure` shows no plaintext secrets in app settings
- [ ] The deployed zip was built by the pipeline on Linux and passed `verify:package`
- [ ] `verify:security` passes on the deployed target (uniform 401, write tools blocked, limits work)
- [ ] `verify:org` passes for every enabled domain (no 401/403)
- [ ] `verify:drift` passes and the snapshot is committed
- [ ] Alerts exist for 5xx, auth failures and restarts, and someone receives them
- [ ] Second-user test in Copilot Studio done
- [ ] You can rotate a key and revoke a PAT in under 10 minutes (RUNBOOK.md, tried once)
- [ ] Stakeholders understand the residual risk: with a shared service identity, every user of the agent sees whatever that identity can see
