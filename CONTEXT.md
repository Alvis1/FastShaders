# FastShaders — Project Context

## Overview
Bi-directional TSL (Three.js Shading Language) visual shader editor. Users build shaders either by connecting nodes in a graph or by writing TSL code — changes in one view sync to the other.

**Stack**: React 18 + TypeScript + Vite | `@xyflow/react` v12 (node graph) | `@monaco-editor/react` (code editor) | `zustand` v5 (state) | `three` 0.181 (WebGPU + TSL) | `tsl-textures` 3.0 | `@dagrejs/dagre` (auto-layout) | `@babel/parser` + `traverse` (code parsing)

---

## Project Structure
```
src/
├── App.tsx                            # Root + SyncController (graph↔code sync orchestration)
├── main.tsx                           # Entry point
├── vite-env.d.ts                      # Type declarations (tsl-textures module)
├── components/
│   ├── CodeEditor/
│   │   ├── CodeEditor.tsx             # Monaco editor with TSL syntax + Save button
│   │   ├── CodeEditor.css
│   │   └── tslLanguage.ts             # TSL language definition, completions, color picker
│   ├── Layout/
│   │   ├── AppLayout.tsx              # Two nested SplitPanes (left: graph | right: code/preview)
│   │   ├── AppLayout.css
│   │   ├── SplitPane.tsx              # Draggable divider (horizontal or vertical)
│   │   └── CostBar.tsx                # GPU complexity bar (totalCost / 200 pts budget)
│   ├── NodeEditor/
│   │   ├── NodeEditor.tsx             # React Flow canvas + keyboard shortcuts + interaction handlers
│   │   ├── NodeEditor.css
│   │   ├── nodes/
│   │   │   ├── ShaderNode.tsx         # Generic node for all ~40 TSL types (dynamic from registry)
│   │   │   ├── ShaderNode.css
│   │   │   ├── ColorNode.tsx          # Color picker node
│   │   │   ├── PreviewNode.tsx        # Noise preview with animated canvas (noise, fractal, voronoi)
│   │   │   ├── PreviewNode.css
│   │   │   ├── OutputNode.tsx         # Output sink (color, normal, position, opacity, roughness)
│   │   │   └── OutputNode.css
│   │   ├── handles/
│   │   │   └── TypedHandle.tsx        # Color-coded handles per data type
│   │   ├── edges/
│   │   │   ├── TypedEdge.tsx          # Multi-channel colored edges, drag-to-disconnect, info card
│   │   │   ├── EdgeInfoCard.tsx       # Data type label badge shown on edge selection
│   │   │   └── EdgeInfoCard.css
│   │   ├── inputs/
│   │   │   └── DragNumberInput.tsx    # Drag-to-adjust number input with acceleration
│   │   └── menus/
│   │       ├── ContextMenu.tsx        # Menu dispatcher (canvas/node/shader/edge)
│   │       ├── ContextMenu.css
│   │       ├── AddNodeMenu.tsx        # Searchable node palette, grouped by category
│   │       ├── NodeSettingsMenu.tsx   # Node properties, duplicate, delete
│   │       ├── ShaderSettingsMenu.tsx # Output node cost display
│   │       └── EdgeContextMenu.tsx    # Edge delete menu
│   └── Preview/
│       ├── ShaderPreview.tsx          # WebGPU canvas: OrthographicCamera, OrbitControls, geometry selector
│       └── ShaderPreview.css
├── engine/
│   ├── graphToCode.ts                 # Graph → TSL code string (import statements + Fn() wrapper)
│   ├── codeToGraph.ts                 # TSL code → nodes + edges (Babel AST parsing)
│   ├── graphToTSLNodes.ts             # Graph → live Three.js TSL node objects (for material)
│   ├── layoutEngine.ts                # Dagre auto-layout (LR, nodesep=25, ranksep=60)
│   ├── topologicalSort.ts             # Kahn's algorithm for execution order
│   └── evaluateTSLScript.ts           # tsl-textures script evaluator (new Function)
├── hooks/
│   └── useSyncEngine.ts               # Bidirectional sync hook (watches graph/code changes)
├── registry/
│   ├── nodeRegistry.ts                # ~44 TSL node definitions (type, ports, defaults, tslFunction)
│   ├── nodeCategories.ts              # Category metadata
│   └── complexity.json                # GPU cost per operation
├── store/
│   └── useAppStore.ts                 # Zustand store (nodes, edges, code, sync, history, UI)
├── types/
│   ├── index.ts                       # Re-exports all types
│   ├── node.types.ts                  # AppNode union, ShaderNodeData, OutputNodeData
│   ├── sync.types.ts
│   └── tsl.types.ts
├── utils/
│   ├── colorUtils.ts                  # Cost color gradient, type→color mapping, category colors
│   ├── idGenerator.ts                 # generateId(), generateEdgeId()
│   └── noisePreview.ts               # CPU noise (Perlin, fBm, Voronoi) + animated render
└── styles/
    ├── tokens.css                     # CSS custom properties (colors, spacing, shadows, fonts)
    └── reset.css
```

---

## Architecture

### Two Code Modes

**Graph Mode (default)** — User builds nodes visually. Graph compiles to TSL code in real-time.
```typescript
// Generated output format:
import { Fn, positionGeometry, mx_noise_float } from 'three/tsl';
const shader = Fn(() => {
  const pos = positionGeometry;
  const noise = mx_noise_float(pos);
  return noise;
});
export default shader;
```

**Script Mode** — User pastes tsl-textures code. Detected by `isTSLTexturesCode()`. Evaluated via `evaluateTSLScript()` using `new Function()` with THREE + tsl-textures in scope. Bypasses graph sync.
```typescript
// Script mode input format:
import { polkaDots } from "tsl-textures";
model.material.colorNode = polkaDots({ count: 4, size: 0.34 });
```

### Sync Engine (prevents infinite loops)
- **`syncSource`** field: `'graph' | 'code' | 'initial'` — tracks who initiated the change
- **`syncInProgress`** flag — blocks nested syncs
- **Graph → Code**: Real-time on every node/edge change (`graphToCode()`)
- **Code → Graph**: Manual via Save button / Ctrl+S (`codeToGraph()` with Babel parser, `errorRecovery: true`)
- **Complexity**: Traverses backward from Output node, sums costs from `complexity.json`

### Zustand Store Shape
```typescript
{
  nodes: AppNode[], edges: AppEdge[]           // Graph data
  code: string, codeErrors: ParseError[]       // Generated code + errors
  totalCost: number                            // Connected node cost sum
  syncSource: 'graph'|'code'|'initial'         // Loop prevention
  syncInProgress: boolean, codeSyncRequested: boolean
  activeScript: string | null                  // Script mode (tsl-textures)
  history: HistoryEntry[], historyIndex: number, isUndoRedo: boolean  // 50-entry undo/redo
  splitRatio: number, rightSplitRatio: number  // Panel sizes (localStorage)
  contextMenu: {
    open: boolean, x: number, y: number,
    type: 'canvas' | 'node' | 'shader' | 'edge',
    nodeId?: string, edgeId?: string
  }
}
```

### Preview (ShaderPreview.tsx)
- **Renderer**: `WebGPURenderer` (from `three/webgpu`)
- **Camera**: `OrthographicCamera` (FRUSTUM_SIZE=3), responsive via ResizeObserver
- **Controls**: `OrbitControls` with damping (drag rotate, scroll zoom)
- **Geometry**: Selector (sphere/cube/torus/plane), default cube at 45/45 degrees
- **Material**: `MeshPhysicalNodeMaterial` — `colorNode` and `normalNode` set from compiled TSL
- **Lighting**: DirectionalLight (follows camera) + AmbientLight
- **Animation**: Play/pause toggle, default paused

---

## Node System

### Node Registry (~44 nodes in 9 categories)

| Category       | Nodes |
|---------------|-------|
| **Input**      | positionGeometry, normalLocal, tangentLocal, time, screenUV, uniform_float |
| **Type**       | float, int, vec2, vec3, vec4, color |
| **Arithmetic** | add, sub, mul, div |
| **Math (unary)** | sin, cos, abs, sqrt, exp, log2, floor, round, fract |
| **Math (binary)** | pow, mod, clamp, min, max |
| **Interpolation** | mix, smoothstep, remap, select |
| **Vector**     | normalize, length, distance, dot, cross |
| **Noise**      | noise (mx_noise_float), fractal (mx_fractal_noise_float), voronoi (mx_worley_noise_float) |
| **Color**      | hsl, toHsl |
| **Output**     | output (color, normal, position, opacity, roughness inputs) |

### React Flow Node Types
- **`shader`** — Generic node for most TSL operations (ShaderNode.tsx)
- **`color`** — Color picker with hex input (ColorNode.tsx)
- **`preview`** — Noise/procedural nodes with animated canvas thumbnail (PreviewNode.tsx)
- **`output`** — Output sink with multiple material property inputs (OutputNode.tsx)

### Preview Nodes (Noise/Procedural)
Noise category nodes render a 96x96 canvas showing their generated pattern:
- **CPU noise**: Perlin 2D, fBm (fractal), Voronoi — evaluated in `noisePreview.ts`
- **Time-conditional animation**: Only animates when a Time node is connected upstream
- **Per-port animation**: BFS traversal detects which input ports receive time signal
  - `pos` port → scrolling coordinate offset
  - `octaves`/`lacunarity`/`diminish` → sine oscillation around base value
- Static render when no Time node is upstream

---

## Type System

**Data types**: `float | int | vec2 | vec3 | vec4 | color | any`

Each type has a distinct color for handles and edges:
- float: `#3366CC` (blue), int: `#20B2AA` (teal), vec2: `#4A90E2` (sky), vec3: `#E040FB` (magenta), vec4: `#AB47BC` (purple), color: `#E8A317` (gold), any: `#607D8B` (slate)

**AppNode union**: `ShaderFlowNode | ColorFlowNode | PreviewFlowNode | OutputFlowNode`

---

## Edge System (TypedEdge.tsx)

### Visual Style
- **Multi-channel rendering**: vec2=2 lines (R,G), vec3/color=3 lines (R,G,B), vec4=4 lines (R,G,B,A)
- **Channel colors**: R=#ff4444, G=#44dd44, B=#4488ff, A=#dddddd
- **Scalar types** (float/int/any): Single line in the type's color
- **Dashed lines** for multi-channel (strokeDasharray `4 1`), solid for single
- **Selected state**: Glow effect via `drop-shadow` filter
- **Type resolution**: Resolves `'any'` to concrete type by checking source output → target input ports

### Interaction
- **Click** → Selects edge, shows EdgeInfoCard (data type badge at edge midpoint)
- **Drag** (>5px threshold) → Disconnects edge from target, starts new connection from source handle
  - Uses pointer capture + synthetic mousedown dispatch on source handle via `requestAnimationFrame`
- **Right-click** → Opens EdgeContextMenu (delete option)
- **Invisible hit area**: 20px wide transparent stroke path for easy interaction

---

## Canvas Interactions (NodeEditor.tsx)

### Keyboard Shortcuts
- **Ctrl+S**: Save / sync code→graph
- **Ctrl+Z**: Undo
- **Ctrl+Shift+Z**: Redo
- **Ctrl+C**: Copy selected nodes (deep clone to clipboard ref)
- **Ctrl+V**: Paste copied nodes (offset +30px, clone edges between copied nodes)
- **Ctrl+D**: Duplicate selected (inline copy+paste)
- **Delete/Backspace**: Remove selected nodes and their connected edges

### Mouse Interactions
- **Left-drag on canvas**: Box selection (partial overlap mode — `SelectionMode.Partial`)
- **Middle/right-drag on canvas**: Pan
- **Scroll**: Zoom (0.1x – 3x range)
- **Right-click canvas**: Opens AddNodeMenu (searchable node palette)
- **Right-click node**: Opens NodeSettingsMenu (edit values, duplicate, delete)
- **Right-click output node**: Opens ShaderSettingsMenu (cost display)
- **Right-click edge**: Opens EdgeContextMenu (delete)
- **Drag from handle → release on empty space**: Opens AddNodeMenu at drop position
- **Drop node on edge**: Inserts node between source and target (bezier curve proximity detection, 40px threshold)

### Drop-on-Edge Insertion
When a node is dragged and dropped near an existing edge:
1. Samples 20 points along the cubic bezier curve between source/target
2. Finds minimum distance from dragged node center to curve
3. If within 40px threshold: removes original edge, creates two new edges through the dropped node
4. Uses first input and first output ports of the dropped node's registry definition

### Connection Rules
- **Single-input enforcement**: Connecting to an already-occupied input replaces the existing edge
- **Reconnect by drag**: Dragging an edge endpoint to a new handle reconnects it
- **Failed reconnect**: Dropping a reconnected edge on empty space deletes it
- **Connection radius**: 80px snap distance

### Selection
- **Partial overlap**: Nodes are selected when the selection box partially overlaps them
- **Selection rectangle hidden**: CSS overrides make the selection box invisible (transparent bg, no border)

---

## Context Menus

### Menu Dispatch (ContextMenu.tsx)
Routes to specific menu based on `contextMenu.type`:
- `'canvas'` → AddNodeMenu
- `'node'` → NodeSettingsMenu
- `'shader'` → ShaderSettingsMenu
- `'edge'` → EdgeContextMenu

### AddNodeMenu
- Auto-focused search input
- Grouped by category when not searching, flat list when searching
- Maps node to React Flow type: output→`'output'`, noise category→`'preview'`, color→`'color'`, else→`'shader'`
- Places node at context menu screen position via `screenToFlowPosition()`
- Prevents adding multiple output nodes

### NodeSettingsMenu
- Displays node label and registry type
- Editable parameters (color inputs for hex, DragNumberInput for numbers)
- Duplicate Node button (structuredClone + offset)
- Delete Node button

### DragNumberInput
- **Drag mode**: Hold + drag left/right to change value (BASE_SPEED=0.005, acceleration factor 0.002)
- **Edit mode**: Click to enter text editing, Enter/Escape/blur to commit
- **Arrow buttons**: ◂/▸ with configurable step (default 0.1)
- **Rounding**: 4 decimals internal, 2 decimals display

---

## Design System (tokens.css)

- **Theme**: Light, flat design with subtle shadows
- **Font**: Inter (sans), JetBrains Mono (mono)
- **Spacing**: 4px base scale (--space-1 through --space-8)
- **Shadows**: 4 levels (sm, md, lg, node) + selected state with blue ring
- **Cost visualization**: Nodes scale (up to 1.35x) and blend color based on GPU cost (green→amber→red)
- **Category colors**: Each node category has a distinct accent color for the header strip

---

## Key Technical Details

### TypeScript Gotchas
- `@babel/traverse` CJS/ESM interop: `const traverse = (typeof _traverse.default === 'function' ? _traverse.default : _traverse)`
- `AppNode` union needs casting for `values`: `(node.data as { values?: Record<string, string | number> }).values`
- React Flow `applyNodeChanges`/`applyEdgeChanges` return base types → need `as AppNode[]` cast
- React Flow `onPaneContextMenu` expects `(event: MouseEvent | React.MouseEvent)`, not just `React.MouseEvent`
- React Flow `onNodeDragStop` expects `React.MouseEvent` (not native `MouseEvent`) for the event parameter

### Three.js TSL Imports Used
From `three/tsl`: Fn, float, int, vec2, vec3, vec4, color, add, sub, mul, div, sin, cos, abs, pow, sqrt, exp, log2, floor, round, fract, mod, clamp, min, max, mix, smoothstep, normalize, length, distance, dot, cross, positionGeometry, normalLocal, tangentLocal, time, screenUV, mx_noise_float, mx_fractal_noise_float, mx_worley_noise_float, hsl, toHsl, remap, select

### Persistence (localStorage)
- `fs:graph` — nodes + edges (auto-save every 300ms)
- `fs:splitRatio` — left/right panel ratio
- `fs:rightSplitRatio` — code/preview ratio
- `fs:geometry` — selected preview geometry type

### History System
- 50-entry undo/redo stack
- `pushHistory()` called before: node drag, connection, paste, duplicate, delete, edge drag-to-disconnect
- `isUndoRedo` flag prevents sync during undo/redo operations
