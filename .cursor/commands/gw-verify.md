# Verify current state

Run every verification command that exists for the phases completed so far (at minimum `npm run lint`, `typecheck`, `test`, `verify:local`; plus `verify:drift` and `verify:secrets` once they exist). Do not fix anything unless I ask; report.

Reply in exactly this format:

1. What changed (files, 5 lines max).
2. Acceptance criteria of the phase just finished: each one PASS or FAIL with evidence.
3. Raw output of the commands you ran.
4. Deviations from the spec, why, with evidence.
5. Risks or questions before the next phase.

If every phase is complete, also confirm each item of this final gate with evidence:

- lint, typecheck, test, verify:local, verify:drift, verify:secrets green on a clean clone
- two-org test registry proves isolation end to end
- parity with the legacy wrapper demonstrated, `legacy/` deleted
- package built on Linux passes `verify:package`
- Bicep what-if clean; `verify:azure` shows no plaintext secret in app settings
- staging deployment passes `verify:security`, `verify:org`, `verify:soak`
- log-redaction test passes; a manual grep of App Service logs after a live run shows no secret
- docs complete and self-dry-run done
