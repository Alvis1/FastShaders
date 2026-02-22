# FastShaders

Bi-directional TSL (Three.js Shading Language) visual shader editor.

## Stack

- React 18 + TypeScript + Vite (ES modules)
- `@xyflow/react` v12 — node graph editor
- `@monaco-editor/react` — code editor
- `zustand` v5 — state management
- `@babel/parser` + `@babel/traverse` — code→graph parsing
- `@dagrejs/dagre` — auto-layout (LR direction)
- `three` + `tsl-textures` — shader runtime
- Path alias: `@/*` → `./src/*`

## Commands

- `npm run dev` — start dev server
- `npm run build` — typecheck + build (`tsc -b && vite build`)
- `npx tsc --noEmit` — typecheck only

No test framework is configured.

## Project Structure

```
src/
  components/
    CodeEditor/       — Monaco editor panel
    Layout/           — Toolbar, CostBar, app layout
    NodeEditor/       — React Flow graph editor
      edges/          — Custom edge types (TypedEdge, EdgeInfoCard)
      handles/        — TypedHandle with color-coded types
      inputs/         — DragNumberInput and other input widgets
      menus/          — AddNodeMenu, NodeSettingsMenu (context menus)
      nodes/          — ShaderNode, OutputNode, PreviewNode, MathPreviewNode, ClockNode
    Preview/          — ShaderPreview (iframe-based 3D preview)
  engine/
    graphToCode.ts    — graph → TSL code generation
    codeToGraph.ts    — TSL code → graph parsing (Babel)
    graphToTSLNodes.ts — graph → TSL node tree
    tslCodeProcessor.ts — shared TSL processing (import extraction, TDZ fix)
    tslToPreviewHTML.ts — TSL → standalone HTML preview
    tslToShaderModule.ts — TSL → A-Frame compatible shader module
    tslToAFrame.ts    — TSL → A-Frame scene HTML
    topologicalSort.ts — Kahn's algorithm (warns on cycles)
    layoutEngine.ts   — Dagre auto-layout
    cpuEvaluator.ts   — CPU-side TSL expression evaluation
    evaluateTSLScript.ts — Script-based TSL evaluation
  hooks/
    useSyncEngine.ts  — bidirectional graph↔code sync
  registry/
    nodeRegistry.ts   — all ~40 TSL node type definitions
  store/
    useAppStore.ts    — zustand store (nodes, edges, code, syncSource)
  types/
    node.types.ts     — AppNode types + getNodeValues() helper
    index.ts          — type re-exports
  utils/
    idGenerator.ts    — generateId(), generateEdgeId() (4-part format)
    colorUtils.ts     — color conversion utilities
    noisePreview.ts   — noise preview generation
public/
  js/
    three-tsl-shim.js       — re-exports window.THREE.TSL for ES modules
    a-frame-shaderloader-0.2.js — A-Frame shader component (TDZ fix + auto-import)
```

## Key Conventions

- **Sync engine**: `syncSource` field in zustand (`'graph'` | `'code'`) prevents infinite sync loops
- **Node values**: always use `getNodeValues(node)` from `@/types` — never cast `node.data as ...`
- **Edge IDs**: always use `generateEdgeId(source, sourceHandle, target, targetHandle)` from `@/utils/idGenerator`
- **Single ShaderNode**: one component handles all TSL node types dynamically via registry
- **Light theme**: flat design with subtle shadows
- **A-Frame pipeline**: graphToCode → tslToShaderModule → shaderloader (runtime TDZ fix + auto-import injection) → dynamic blob import
- **rAF ref pattern**: PreviewNode/MathPreviewNode overwrite refs for animation — this is correct (avoids stale closures)

## TypeScript Notes

- `@babel/traverse` CJS/ESM interop: `const traverse = (typeof _traverse.default === 'function' ? _traverse.default : _traverse)`
- React Flow v12: import from `@xyflow/react`, use `Node<DataType, TypeName>` generics
- `applyNodeChanges`/`applyEdgeChanges` return base types — cast with `as AppNode[]`
- `@types/three` uses `>=0.182.0` range (not caret) to match installed version
