# Phase 5: verification scripts and onboarding tool

Read first: `20-verification.mdc` (all of it), `50-traps.mdc`.

Tasks

1. Implement every script in `20-verification.mdc` (1 to 9) with the preflight and result-table conventions, plus the npm aliases. `verify:local` must now run the full test matrix.
2. `scripts/onboard-org.mjs`: args `--alias --org --auth pat|entra-sp --domains ... [--tenant --client]`. Validate with the same zod schema. Append the entry to `config/orgs.json` (formatted, sorted). Print the exact `az keyvault secret set` commands for the secrets needed. **Never accept secret values as arguments**: prompt with hidden input or read stdin. Print the Copilot Studio values (URL, header name). Offer to run `verify:org` at the end.
3. Add `scripts/parity.mjs` if not done in Phase 2.

Accept

- `npm run verify:local`, `verify:drift`, `verify:secrets` are green on a clean clone.
- Onboarding a fake org on a clean clone produces a valid registry, and `verify:local` still passes.
- Scripts that need Azure or a live org (`verify:azure`, `verify:org`, `verify:security` against a deployed URL, `verify:soak`, `verify:package`) run with `--help` and fail their preflight cleanly when prerequisites are missing. Show that output.

Then run `/gw-verify` and stop.
