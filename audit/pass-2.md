# Pass 2 — Bloat (cap: 15 findings)

- **Dependencies:** read `package.json`. For each dep, `rg` for import sites. Report deps with 0 or 1 usage, and any duplicated-purpose pairs.
- **Dead exports:** `rg "^export " --type ts -l` to list export-bearing files, then sample 10 random exports and check for importers. Extrapolate.
- **Oversized components:** list React components >300 lines or with >5 distinct responsibilities.
- **Re-render hazards:** object/array literals passed as props, Zustand selectors without `shallow`, context values that change identity every render.
- **Bundle:** check `vite.config.*` for chunking strategy and dynamic imports. Verify whether Monaco AND CodeMirror are both bundled — if so, flag it.

**Only inspect `dist/` if it already exists.** Do not run a build. If no build artifacts are present, skip all bundle-size claims rather than guess.
