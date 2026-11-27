# Intro models

The two models the intro window's models slide drops onto its 3D view
(`src/intro/ModelScene.tsx`); the figure is also the multi-mesh slide's model
(`src/intro/MeshesScene.tsx` — its 15 meshes). Fetched only when a slide that
uses them first shows.

| File | What | Source |
| --- | --- | --- |
| `rodin.glb` | Rodin's *The Thinker*, untextured | The `a-frame-shaderloader` repository's `objects/rodin.glb` (byte-identical copy) |
| `PoseableFigure_02.glb` | A poseable mannequin with one skinned walk cycle (`mixamo.com_remap`) | The author's test objects (`private/test-objects/`) |

`src/intro/introScenes.test.ts` reads both files: it pins that a drop of the
figure ASKS "Only Mesh / Mesh with Materials" and a drop of Rodin does not,
which is what the slide shows.
