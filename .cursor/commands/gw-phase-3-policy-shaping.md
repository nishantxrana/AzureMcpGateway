# Phase 3: tool policy and response shaping

Read first: `10-architecture.mdc` (allowlist, action regex), `20-verification.mdc` (policy, shaping, tool-drift), `50-traps.mdc`, and `.cursor/kit/reference/fixtures/pipelines_build.list.sample.txt`.

Tasks

1. `src/ado/toolPolicy.ts`: default-deny allowlist, per-org `extraAllow` and `extraDeny`, and the action deny regex. Generate `config/tool-snapshot.json` (every tool name and every `action` enum value for the pinned official version and the 5 default domains). Implement `scripts/verify/tool-drift.mjs`.
2. `src/ado/shape.ts`, applied to every text content block:
   1. Detect the envelope with `/^(<<[0-9a-f]+>> \[UNTRUSTED [^\]]*\] <<[0-9a-f]+>>)\n([\s\S]*)\n(<<\/[0-9a-f]+>>)\s*$/`. If it does not match, pass through unchanged (still apply the size cap).
   2. `JSON.parse` the payload. If that fails, pass through unchanged.
   3. Recursively remove: `_links` (first copy `_links.web.href` to a sibling `webUrl` when present), `avatar`, `imageUrl`, `descriptor`, `drafts`, `plans`, `triggerInfo`, `validationResults`, `orchestrationPlan`, `retainedByRelease`, `appendCommitMessageToRunName`, `badge`, empty `properties`. Remove empty arrays, empty objects and nulls. Keep the key list as one constant.
   4. Collapse any nested `project` object to `{id, name}` and any nested identity object (has `displayName` and `uniqueName`) to `{displayName, uniqueName}`.
   5. Serialize compactly and re-wrap in the **original** envelope, unchanged.
   6. If the result exceeds `maxResponseChars` (default 60000): for arrays keep leading items that fit and append a **second** content block: `Output truncated: returned N of M items. Narrow the query (smaller top, specific project, date range).` For other payloads truncate the string and append the same note.
3. Never alter `isError`. Never remove `id`, `name`, `status`, `result`, `webUrl`, dates, branch or repository names.

Accept

- On the fixture the shaped output is at least 60% smaller, still valid JSON inside an intact envelope, and keeps `id`, `buildNumber`, `status`, `result`, `sourceBranch`, `webUrl`, definition name, project name.
- Fuzz test: 200 random JSON payloads never throw and never grow.
- Oversized-array truncation test.
- `verify:drift` passes and fails when a fake extra tool or a mutation-like action on an allowlisted tool is injected.

Then run `/gw-verify` and stop.
