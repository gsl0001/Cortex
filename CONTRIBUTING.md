# Contributing to Cortex

Thanks for considering a contribution. Cortex aims to stay small, local, and
dependency-light — a single Node process over `node:sqlite`, no external
services. Contributions that keep it that way are the most welcome.

## Getting set up

Requires **Node.js ≥ 25** (for the built-in `node:sqlite` module).

```bash
git clone https://github.com/gsl0001/Cortex.git cortex
cd cortex
npm install
npm test            # backend suite (node:test)
npm run web:test    # web UI tests (vitest)
npm run web:build   # production build
npm start           # run the hub at http://127.0.0.1:4317
```

All three test/build commands should pass on a clean checkout before you start.

## Ground rules

- **Tests come with the change.** New behavior or a bug fix ships with a test
  that fails without it. We use `node:test` for the backend and `vitest` for the
  web UI — no other test frameworks.
- **Keep the dependency count low.** Prefer the standard library and built-in
  platform features over a new package. A few lines of code usually beats a
  dependency. If you must add one, say why in the PR.
- **Match the surrounding style.** No linter is enforced; read the neighboring
  code and mirror it. Comments explain *why*, not *what*.
- **Security posture is a feature, not an obstacle.** Writes are default-deny,
  the server is loopback-only unless explicitly opened, and Autopilot never runs
  against repos in `CORTEX_NEVER_AUTOPILOT`. Don't weaken these without a
  discussion first.

## Submitting a change

1. Open an issue first for anything non-trivial, so we can agree on the approach.
2. Branch, implement with tests, and make sure `npm test`, `npm run web:test`,
   and `npm run web:build` all pass.
3. Open a PR with a clear description of the problem and the fix. Small, focused
   PRs get reviewed faster.

## Good first issues

Issues labeled [`good first issue`](https://github.com/gsl0001/Cortex/labels/good%20first%20issue)
are scoped to be approachable without deep knowledge of the codebase. They're a
great place to start.

## Reporting bugs

Include your Node version (`node --version`), your OS, the command you ran, and
what happened versus what you expected. A failing test case is the gold standard.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
