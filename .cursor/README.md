# ADO MCP Gateway kit for Cursor

Everything Cursor needs lives under `.cursor/`, so the repo root stays clean.

```
.cursor/
  README.md                     this file
  rules/                        the specification, split by concern (.mdc is required)
    00-standing-rules.mdc       always on: non-negotiables and working style
    10-architecture.mdc         facts, architecture, decisions, registry schema, allowlist
    20-verification.mdc         verification scripts and test matrix
    30-delivery.mdc             zip packaging, Bicep, Azure DevOps pipeline (no Docker)
    40-docs.mdc                 documentation and runbooks to write
    50-traps.mdc                known traps (agent-requested)
  commands/                     type / in Cursor's chat to run these
    gw-plan.md                  read everything, produce a plan, write no code
    gw-phase-0-baseline.md ... gw-phase-7-docs.md
    gw-verify.md                run checks and report in a fixed format
    gw-review.md                security review of the current diff
  kit/
    PREREQUISITES.md            for YOU: what must exist before running scripts
    reference/                  verified spike code and a real-shaped fixture (read-only)
```

## How to use

1. Unzip into the repo root (it only adds `.cursor/`). Commit it.
2. Work through `.cursor/kit/PREREQUISITES.md`, sections A to F at least.
3. Open the repo in Cursor, start Agent mode, type `/gw-plan`. Read the plan and the objections, answer them, then say "go".
4. Run the phases in order: `/gw-phase-0-baseline`, `/gw-phase-1-registry-secrets`, `/gw-phase-2-gateway-core`, `/gw-phase-3-policy-shaping`, `/gw-phase-4-hardening`, `/gw-phase-5-verification`, `/gw-phase-6-package-iac-cicd`, `/gw-phase-7-docs`.
5. Each phase ends with `/gw-verify`. Do not start the next phase until every acceptance item shows PASS with evidence.
6. Before merging any phase run `/gw-review`.

## Notes

- Rules must be `.mdc` files with frontmatter; plain `.md` files in `.cursor/rules` are ignored by Cursor. Commands are plain `.md` files in `.cursor/commands`.
- Glob-scoped rules attach only when matching files are in context, which is why every command tells Cursor to read the rule files explicitly.
- If `/` does not list the commands, update Cursor (custom commands need a recent version) and reopen the folder.
- `.cursor/` must never be shipped. The packaging script excludes it.
- Phase 2 and Phase 6 include steps only you can do (parity against your real org, pipeline runs, `what-if`). Cursor is told to prepare scripts and ask you to run them.
