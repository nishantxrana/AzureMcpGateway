# Phase 6: package, infrastructure as code, CI/CD (zip deploy, no Docker)

Read first: `30-delivery.mdc` (all of it), `20-verification.mdc` (scripts 4 and 9), `50-traps.mdc` (zip deployment section), `.cursor/kit/PREREQUISITES.md` sections B, C and H.

Tasks

1. `scripts/package.mjs` exactly as specified (Linux x64 only; `--dry-run` allowed elsewhere and stamped NOT DEPLOYABLE).
2. `scripts/verify/package.mjs` including the ELF check and the unzip-and-start smoke test.
3. `infra/` Bicep modules and `main.bicep`, `main.parameters.example.json`, `infra/README.md` (what-if then create; the bootstrap Oryx path clearly labelled non-production).
4. `azure-pipelines.yml` with the four stages, workload identity federation, keys read from Key Vault at run time, approval gate, swap and automatic swap-back.
5. Renovate or Dependabot config for `@azure-devops/mcp`.

Accept

- `node scripts/package.mjs --dry-run` works on this Windows machine and clearly refuses a real build here. Show the output.
- `verify:package` passes on a package built in a Linux environment. If you have no Linux environment locally, say so and make the pipeline produce it; I will run the pipeline.
- `az bicep build` and `az deployment group what-if` succeed (I will run what-if against my subscription; give me the exact commands).
- The pipeline YAML validates (schema-valid; do not invent tasks that do not exist).

Then run `/gw-verify` and stop.
