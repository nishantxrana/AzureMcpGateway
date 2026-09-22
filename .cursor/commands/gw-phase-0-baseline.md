# Phase 0: baseline and tooling

Read first: `00-standing-rules.mdc`, `10-architecture.mdc`.

Tasks

1. Convert the repo to TypeScript strict ESM for Node 22 (`"engines": {"node": ">=22"}`), `tsx` for dev, `tsc` build to `dist/`.
2. npm scripts: `build`, `lint`, `typecheck`, `test`, `dev`, `start` (`node dist/index.js`), `verify:local` (placeholder that exits 0 until Phase 5).
3. Add `.gitignore` (node_modules, dist, artifacts, `.env*` except `.env.example`), `.gitattributes` (`* text=auto eol=lf`), `.editorconfig`, `.env.example` with placeholders only, ESLint, Prettier, vitest.
4. Move `start.mjs` to `legacy/`. Keep it runnable until Phase 2 parity is proven.
5. Create the empty directory skeleton from the layout in `10-architecture.mdc`.

Accept

- `npm run lint && npm run typecheck && npm test` pass on a clean clone (`git clone` to a temp dir and run `npm ci` first).
- `legacy/start.mjs` still starts.

Then run `/gw-verify` and stop.
