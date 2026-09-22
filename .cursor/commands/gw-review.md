# Security review of the current changes

Review `git diff` (and untracked files) against `.cursor/rules/00-standing-rules.mdc` and `50-traps.mdc`. Do not modify code; report.

Check specifically:

- any log, error message, test snapshot or fixture that could contain a secret, token, key or Authorization header
- any path where the child process could inherit the gateway env
- any place a non-allowlisted tool or a mutation-like action could be reached
- any difference in status code, body or timing between unknown alias, missing key and wrong key
- unbounded resource use: body size, response size, child count, queue length, timeouts, missing kills
- writes under the app directory at runtime; shell string building; `npx` or shell usage
- new dependencies (justify each; check maintenance and known advisories with `npm audit`)
- anything that would break Copilot Studio compatibility (SSE, sessions, complex JSON Schema, more than 128 tools)

Output a table: `Severity (High/Med/Low) | File:line | Finding | Suggested fix`, then a one-line verdict: SHIP / FIX FIRST.
