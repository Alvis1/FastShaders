# Pass 1 — Consistency (cap: 15 findings)

Read 3–5 representative files first to establish what the conventions actually are. Then report violations against **those** conventions, not against your priors.

- **State ownership:** where is the same data owned by both Zustand and React Flow's internal state? Where does local `useState` shadow store state?
- **Node taxonomy:** do the ~55 node types share one definition pattern? Cite divergences with file paths.
- **TypeScript escape hatches:** run `rg "@ts-ignore|@ts-expect-error|as unknown as|: any\b" --type ts`. Report the total count and the 5 most consequential cases.
- **Error handling:** trace the three most important user paths (load file, save file, compile shader). Report where failures are swallowed vs. surfaced.
