# `docs/dev` — the reasoning behind CLAUDE.md's rules

`CLAUDE.md` is loaded into every Claude Code session, so it holds the **rules** only:
one to three lines each, enough to stop someone re-introducing a bug. The paragraphs
that explain *why* — the measurements, the browser-by-browser results, the approaches
that were tried and reverted — live here and are read on demand.

Nothing was rewritten in the move: **every paragraph in these files is the original
CLAUDE.md text, verbatim.** If a rule in CLAUDE.md looks arbitrary, the answer is in
the matching file below.

| File | Covers |
|---|---|
| [platform-and-release.md](platform-and-release.md) | Browser floor, offline/desktop builds, vendoring, the submodule + jsdelivr release order, the feedback button |
| [eval-mode.md](eval-mode.md) | The user-study switch: arms, consent, telemetry vocabulary, the package, the upload |
| [graph-and-store.md](graph-and-store.md) | Sync engine, store, history bracketing, ids, rAF loops, import auto-fit |
| [storage-and-limits.md](storage-and-limits.md) | Every `fs:*` localStorage key, ASCII storage, image payload refs, viewport/scroll memory, cost profiles |
| [codegen.md](codegen.md) | `graphToCode` / `codeToGraph` contracts, emission rules, alpha, discard, module helpers |
| [outputs-and-materials.md](outputs-and-materials.md) | Output nodes, one-node-one-material, `parts` / `materialParts`, the active sink, emit order |
| [sdf-and-raymarch.md](sdf-and-raymarch.md) | Distance-field nodes, helper variants, the Raymarch Output |
| [node-types.md](node-types.md) | Noise ranges, colormaps, the dataviz family, the Data Range formula, Time, Sound |
| [images-and-textures.md](images-and-textures.md) | The Image (Texture) node, drop-time conversion, the resolution ladder, revert-to-original |
| [node-visuals-and-designer.md](node-visuals-and-designer.md) | Node appearance, selection/lift, theming, glyphs, the Node Designer, the colour picker |
| [canvas-interaction.md](canvas-interaction.md) | Navigation model, node placement, edges, drag-connect, groups, Preview mode |
| [preview-and-runtime.md](preview-and-runtime.md) | The sandboxed preview, shaderloader 0.8, podest, XR, preview geometries, `fit-bounds` |
| [models-and-gltf.md](models-and-gltf.md) | Dropped models, the trusted-side glTF reader, GLB import/export, decoders, zip limits |
| [discovery-and-i18n.md](discovery-and-i18n.md) | Node search ranking, editor visibility, optional categories, the Latvian overlay |
| [project-structure.md](project-structure.md) | The full annotated source tree — several rules exist only in these annotations |
| [testing.md](testing.md) | Test harness contracts (`isolate: false`, the shared factories, the loader harness) and the coverage inventory |

## Keeping the two in step

When a rule changes, update **both**: the one-liner in `CLAUDE.md` and the full
paragraph here. A rule whose reasoning has silently rotted is worse than no rule —
it will be followed without anyone being able to check whether it still applies.

When adding a rule, write the reasoning here first and derive the one-liner from it.
If the one-liner needs more than about three lines to be safe to follow, that is a
sign the rule is really two rules.
