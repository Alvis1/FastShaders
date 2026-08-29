import { memo, useCallback, useEffect, useMemo, type CSSProperties } from 'react';
import { Position, useStore, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode, PortDefinition, NodeCategory } from '@/types';
import { NODE_REGISTRY, effectiveInputs, growsOperands } from '@/registry/nodeRegistry';
import { appendGrowthExhausted } from '@/utils/appendCapacity';
import { useAppStore } from '@/store/useAppStore';
import { useHistoryBracket } from '@/hooks/useHistoryBracket';
import { portLabel } from '@/i18n';
import { getCostColor, getCostScale, getCostTextColor, CAT_HEX, getContrastColor } from '@/utils/colorUtils';
import { nodeCostPoints } from '@/utils/nodeCost';
import { TypedHandle } from '../handles/TypedHandle';
import { DragNumberInput } from '../inputs/DragNumberInput';
// Imported BEFORE './ShaderNode.css' so the bundler emits PaletteColorPicker.css
// first: `.shader-node__input-color` and `.palette-swatch` have equal
// specificity, and the on-node size must win. (The size override below is also
// written under `.shader-node__left` so it does not depend on that ordering.)
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import { NodeGlyph, hasNodeGlyph, usesOperatorLayout, nodeJustify, nodeScale, nodeBox, nodeSockets, nodeTextScale, nodeArtStyle } from './glyphs/NodeGlyph';
import { evaluateNodeOutput, evaluateEdgeSource, evaluateEdgeRange, getEdgeOutputShape, getTargetEdges, getTimeUpstreamSet, getNodeById } from '@/engine/cpuEvaluator';
import { edgeRangeText } from '@/utils/edgeValueText';
import { LiveEdgeValue } from './LiveEdgeValue';
import { makeConnectionRevealSelector } from './connectionReveal';
import { RevealSockets } from './RevealSockets';
import { RAMP_COLOR_NODES, effectiveRampDef } from '@/utils/exposedPorts';
import { displayImageFileName, validImageDataUrl } from '@/utils/imageNode';
import { getColormap, colormapGradientCss } from '@/utils/colormaps';
import { parseFormula, hasCustomFormula } from '@/utils/dataRangeFormula';
import './ShaderNode.css';
import { NODE_BORDER_WIDTH } from './nodeFrame';

// (fmtNum/rangeText moved to utils/edgeValueText.ts — shared with the
// animated LiveEdgeValue span so both paths format identically.)

/** Channel count flowing out of one output SOCKET (1–4) — same formula
 *  TypedEdge uses: the larger of live evaluation length and static shape
 *  inference, both measured for the socket the edge leaves. Per-socket, not
 *  per-node: a node with an `out` port reports that port's width for every
 *  handle otherwise, so an RGB-to-HSL Lightness wire would draw a 3-line
 *  ribbon. */
function channelCount(
  nodeId: string,
  sourceHandle: string | null | undefined,
  nodes: Parameters<typeof evaluateNodeOutput>[1],
  edges: Parameters<typeof evaluateNodeOutput>[2],
): number {
  const edge = { source: nodeId, sourceHandle };
  const out = evaluateEdgeSource(edge, nodes, edges, 0);
  const evalLen = out?.length ?? 0;
  const shapeLen = getEdgeOutputShape(edge, nodes, edges);
  return Math.min(Math.max(evalLen, shapeLen, 1), 4);
}

/** Node-body stack: px down per extra output channel layer. */
const STACK_STEP_Y = 3;

/**
 * Label for the value(s) arriving on a connected input edge.
 * - one channel → the number
 * - many channels → `min…max` range
 * - unevaluable upstream (texture etc.) → inferred `min…max` range
 * - nothing derivable (camera/world-space chains) → `…`
 * Returns the text, whether it's a live value (vs. an inferred range), and
 * whether the label should ANIMATE (render it through LiveEdgeValue, which
 * re-evaluates on the shared app clock): a time-driven chain's probe at t=0
 * is a frozen arbitrary sample — sin(0) = 0 read as a dead wire.
 * (Formatting rules live in utils/edgeValueText — single values keep
 * decimals, true ranges round to whole numbers; precise figures are the
 * EdgeInfoCard's job.)
 */
export function edgeValueLabel(
  sourceId: string,
  nodes: Parameters<typeof evaluateNodeOutput>[1],
  edges: Parameters<typeof evaluateNodeOutput>[2],
  /** The socket the edge LEAVES. A multi-output node (RGB to HSL's h/s/l,
   *  Split's x/y/z/w) evaluates to its whole vector, so without this the
   *  label prints channel 0 for every socket — a Saturation wire would show
   *  Hue in live blue. */
  sourceHandle?: string | null,
): { text: string; live: boolean; animated: boolean } {
  // A noise node's "live" value is one arbitrary probe point — cpuEvaluator
  // samples a fixed UV, and an unwired node lands on an integer lattice where
  // Perlin is exactly 0, which on a card reads as a dead wire. The interval is
  // both the honest answer for a noise field and the only on-canvas tell of the
  // node's range mode (`-1…1` vs `0…1`). The same rule keeps noise OUT of the
  // animated path: a ticking probe point would still be one arbitrary sample
  // of a field. It is decided on the SOURCE NODE's category, BEFORE any
  // per-socket projection — the interval is the honest answer for every one
  // of a noise node's sockets.
  const srcType = getNodeById(nodes, edges, sourceId)?.data?.registryType as string | undefined;
  const preferRange = NODE_REGISTRY.get(srcType ?? '')?.category === 'noise';
  // Time-driven (on the UNWRAPPED graph, so a Time feeder inside a collapsed
  // frame still counts — the MathPreviewNode xKey pairing) → the label ticks.
  // Via the ctx-memoized SET, never the per-node `hasTimeUpstream`: this runs
  // inside `edgeKey` below, i.e. once per connected edge per card per store
  // notify, and the per-node form rebuilt two whole-graph Maps every time.
  const animated = !preferRange && getTimeUpstreamSet(nodes, edges).has(sourceId);
  const edge = { source: sourceId, sourceHandle };
  const out = preferRange ? null : evaluateEdgeSource(edge, nodes, edges, 0);
  if (out && out.length >= 1 && out.every((v) => Number.isFinite(v))) {
    return { text: edgeRangeText(Math.min(...out), Math.max(...out)), live: true, animated };
  }
  // The range is PROJECTED, never re-derived — the signed-noise convention
  // depends on the interval the evaluator produced.
  const r = evaluateEdgeRange(edge, nodes, edges, 0);
  if (r && r.min.length) {
    const lo = Math.min(...r.min), hi = Math.max(...r.max);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      return { text: edgeRangeText(lo, hi), live: false, animated };
    }
  }
  // Connected, but neither eval nor range inference knows the value — show an
  // ellipsis so the socket still reads as carrying *something*. Still animated
  // when time-driven: the rAF path evaluates at REAL times, where a chain like
  // `time` itself (no finite static range) produces a perfectly good number.
  return { text: '…', live: false, animated };
}

export interface PortRow {
  input: PortDefinition | null;
  output: PortDefinition | null;
  settingKey: string | null;
  settingType: 'number' | 'color' | 'vec3' | 'vec2' | null;
  /** For vec3/vec2 rows, the base key (without _x/_y/_z suffix) */
  vecBaseKey?: string;
}

/**
 * Build the visual row layout for a ShaderNode.
 *
 * Rows pair up input ports (left side) with output ports (right side).
 * Inline settings (numbers, colors) are attached to their port row.
 *
 * Special handling:
 * - Keys ending in `_x/_y/_z` are grouped into compact vec3 rows
 * - Keys ending in `_x/_y` (no `_z`) are grouped into vec2 rows
 * - Non-port settings (vec3/vec2/color not backed by an input port) are
 *   appended as extra rows after the input port rows
 * - Property nodes hide the `name` key (shown in the header instead)
 */
export function buildRows(
  def: { type?: string; inputs: PortDefinition[]; outputs: PortDefinition[]; defaultValues?: Record<string, string | number> },
  outputsOverride?: PortDefinition[],
): PortRow[] {
  const rows: PortRow[] = [];
  // Data nodes carry a per-instance output list (one per CSV column); every
  // other node uses its registry-defined outputs.
  const outs = outputsOverride ?? def.outputs;
  const allDefaults = def.defaultValues ?? {};
  const defaults = def.type === 'property_float' || def.type === 'property_color'
    ? Object.fromEntries(Object.entries(allDefaults).filter(([k]) => k !== 'name'))
    : def.type === 'slider'
      ? Object.fromEntries(Object.entries(allDefaults).filter(([k]) => k !== 'min' && k !== 'max'))
      : allDefaults;

  if (def.inputs.length === 0 && Object.keys(defaults).length > 0) {
    // No input ports but has settings (float, color, property_float, vec3, vec2)
    const keys = Object.keys(defaults);
    // Group _x/_y/_z keys into vec rows
    const consumed = new Set<string>();
    const orderedKeys: { key: string; type: 'number' | 'color' | 'vec3' | 'vec2'; baseKey?: string }[] = [];

    for (const key of keys) {
      if (consumed.has(key)) continue;
      if (key.endsWith('_x')) {
        const base = key.slice(0, -2);
        if (keys.includes(`${base}_z`)) {
          consumed.add(key);
          consumed.add(`${base}_y`);
          consumed.add(`${base}_z`);
          orderedKeys.push({ key, type: 'vec3', baseKey: base });
        } else if (keys.includes(`${base}_y`)) {
          consumed.add(key);
          consumed.add(`${base}_y`);
          orderedKeys.push({ key, type: 'vec2', baseKey: base });
        } else {
          orderedKeys.push({ key, type: 'number' });
        }
      } else if (key.endsWith('_y') || key.endsWith('_z')) {
        // Skip — already consumed by a vec group
        if (!consumed.has(key)) orderedKeys.push({ key, type: 'number' });
      } else {
        orderedKeys.push({
          key,
          type: String(defaults[key]).startsWith('#') ? 'color' : 'number',
        });
      }
    }

    const maxLen = Math.max(orderedKeys.length, outs.length);
    for (let i = 0; i < maxLen; i++) {
      const entry = orderedKeys[i];
      rows.push({
        input: null,
        output: outs[i] ?? null,
        settingKey: entry?.key ?? null,
        settingType: entry?.type ?? null,
        vecBaseKey: entry?.baseKey,
      });
    }
  } else {
    // Collect non-port settings (vec3/vec2/color keys not in inputs)
    const portIds = new Set(def.inputs.map(inp => inp.id));
    const extraSettings: { key: string; type: 'number' | 'color' | 'vec3' | 'vec2'; baseKey?: string }[] = [];
    const consumed = new Set<string>();
    const allKeys = Object.keys(defaults);

    for (const key of allKeys) {
      if (consumed.has(key) || portIds.has(key)) continue;
      if (key.endsWith('_x')) {
        const base = key.slice(0, -2);
        if (!portIds.has(base)) {
          if (allKeys.includes(`${base}_z`)) {
            consumed.add(key); consumed.add(`${base}_y`); consumed.add(`${base}_z`);
            extraSettings.push({ key, type: 'vec3', baseKey: base });
          } else if (allKeys.includes(`${base}_y`)) {
            consumed.add(key); consumed.add(`${base}_y`);
            extraSettings.push({ key, type: 'vec2', baseKey: base });
          }
        }
      } else if (key.endsWith('_y') || key.endsWith('_z')) {
        // skip consumed
      } else if (!portIds.has(key)) {
        extraSettings.push({
          key,
          type: String(defaults[key]).startsWith('#') ? 'color' : 'number',
        });
      }
    }

    const maxLen = Math.max(def.inputs.length + extraSettings.length, outs.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < def.inputs.length) {
        const inp = def.inputs[i];
        const key = inp.id in defaults ? inp.id : null;
        rows.push({
          input: inp,
          output: outs[i] ?? null,
          settingKey: key,
          settingType: key ? (String(defaults[key]).startsWith('#') ? 'color' : 'number') : null,
        });
      } else {
        const extra = extraSettings[i - def.inputs.length];
        rows.push({
          input: null,
          output: outs[i] ?? null,
          settingKey: extra?.key ?? null,
          settingType: extra?.type ?? null,
          vecBaseKey: extra?.baseKey,
        });
      }
    }
  }

  // Guarantee at least one row for output-only nodes (e.g. positionGeometry)
  if (rows.length === 0 && outs.length > 0) {
    for (const out of outs) {
      rows.push({ input: null, output: out, settingKey: null, settingType: null });
    }
  }

  return rows;
}

/**
 * Data Range's custom-formula marker: this node computes something its method
 * name no longer describes, which is the surprising state and therefore the one
 * that gets marked (the `×speed` / `±1` precedent).
 *
 * Its meaning is deliberately EXACT, because a marker that overstates what it
 * knows is worse than none. `ƒ` means "carries a formula the grammar accepts";
 * `ƒ!` means "carries one the grammar REJECTS", which is always wrong wherever
 * it is opened. It does NOT claim the shader is running the formula: the other
 * rejection class (`non-finite` — a divisor that folds to zero) depends on the
 * wired column's statistics, and reaching those from a node component costs a
 * whole-graph subscription per node. That case is reported in the generated
 * code instead, as a comment graphToCode writes beside the fallback chain —
 * visible in the code panel, the Output tab and the downloaded `.js`.
 *
 * Its own component so the parse happens once per render, and memoized on the
 * string because ShaderNode re-renders on every graph notify while the formula
 * changes only when someone edits it.
 */
const FormulaChip = memo(function FormulaChip({ formula }: { formula: string }) {
  const ok = useMemo(() => parseFormula(formula).ok, [formula]);
  return (
    <span
      className={`shader-node__formula-chip${ok ? '' : ' shader-node__formula-chip--bad'}`}
      title={formula}
    >
      {ok ? 'ƒ' : 'ƒ!'}
    </span>
  );
});

export const ShaderNode = memo(function ShaderNode({
  id,
  data,
  selected,
}: NodeProps<ShaderFlowNode>) {
  const def = NODE_REGISTRY.get(data.registryType);
  // Rules-of-Hooks note: this return sits ABOVE the hooks below. Safe because
  // `def` cannot flip defined<->undefined on a MOUNTED instance: React Flow keys
  // node components by node.id, every registryType the app writes is in
  // NODE_REGISTRY (`unknown` included), and nothing mutates registryType in place
  // to or from an unregistered value. A tampered .fastshader with an unknown
  // registryType renders null for the whole life of that node. Moving the return
  // below the hooks is NOT a mechanical edit here (ShaderNode/PreviewNode hooks
  // dereference `def`) — see CLEAN-3.
  if (!def) return null;

  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const varName = useAppStore((s) => s.nodeVarNames[id]);
  // The header string, computed once for BOTH layouts: a property node labels
  // itself with the name the user typed, everything else with the generated
  // var name. Also the `title` — the header clamps at two lines (NodeBase.css),
  // so a long name must stay readable on hover.
  const headerText =
    (data.registryType === 'property_float' || data.registryType === 'property_color') && data.values?.name
      ? String(data.values.name)
      : varName ?? data.label;
  const language = useAppStore((s) => s.language);
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  // A wire being dragged within snapping distance of this node — one shared
  // signal (see connectionReveal.ts) that drives every proximity behavior:
  // rows-layout nodes force their input name-tooltips visible (floated left
  // of each socket) so the user can read their target while aiming (operator
  // cards opt out — generic a/b labels are noise); chainable arithmetic
  // mounts its NEXT operand socket; the Image node additionally mounts its
  // hidden param sockets.
  const near = useStore(
    useMemo(() => makeConnectionRevealSelector(id, def.inputs.length > 0), [id, def]),
  );
  // A socket-growing node (variadic arithmetic, append) exposes its NEXT
  // operand socket only while an output wire is dragged within reach; at rest
  // the node stays at its wired socket count — no persistent empty slot
  // cluttering it.
  const revealGrowth = near && growsOperands(def);
  // Image node: an approaching wire reveals ALL param sockets (named by their
  // forced tooltips) so any parameter can be wired without a menu round-trip;
  // landing the connection makes the exposure permanent (onConnect), releasing
  // elsewhere hides them again.
  const revealHidden = near && data.registryType === 'imageNode';
  // Image node thumbnail: render ONLY the validated data: URL — the stored
  // value comes from adversarial graph JSON and must never reach <img src>
  // raw (a remote URL there is a tracking beacon).
  const imageThumbUrl = useMemo(
    () => (data.registryType === 'imageNode' ? validImageDataUrl(data.values?.imageB64) : null),
    [data.registryType, data.values?.imageB64],
  );
  const catHex = CAT_HEX[def.category as NodeCategory] ?? CAT_HEX.unknown;

  // ── Edge-derived render inputs, without a whole-array subscription ──────
  // The store's nodes/edges arrays get a NEW identity on every drag
  // pointermove, so subscribing to them re-rendered every card on the canvas
  // 60×/s (memo() bypassed). Instead, fold everything edge-derived this card
  // renders — connected sockets, per-input value labels, channel widths —
  // into ONE primitive string via the shared evaluator ctx (cheap cache hits
  // per graph version): position-only notifies produce an identical string
  // and Object.is bails before any re-render. The heavy structures are then
  // rebuilt from getState() only when the key actually changes.
  const edgeKey = useAppStore((s) => {
    let key = '';
    for (const e of getTargetEdges(s.nodes, s.edges, id)) {
      const th = typeof e.targetHandle === 'string' ? e.targetHandle : '';
      const sh = typeof e.sourceHandle === 'string' ? e.sourceHandle : '';
      const label = th ? edgeValueLabel(e.source, s.nodes, s.edges, e.sourceHandle) : null;
      const ch = channelCount(e.source, e.sourceHandle, s.nodes, s.edges);
      // `animated` rides the key too: wiring Time into an EXISTING upstream
      // chain can leave text/live unchanged (sin(0) is 0 either way), and a
      // stale flag would keep the label frozen after it became time-driven.
      // `sh` likewise: re-wiring from one socket of a source to ANOTHER (HSL's
      // h → s) leaves source, target and targetHandle identical, so without it
      // Object.is bails and the card keeps showing the old channel forever.
      key += `${e.source}\u0000${sh}\u0000${th}\u0000${label ? label.text : ''}\u0000${label?.live ? 1 : 0}${label?.animated ? 1 : 0}\u0000${ch}\u0001`;
    }
    return key;
  });
  const graphInfo = useMemo(() => {
    const { nodes: allNodes, edges: allEdges } = useAppStore.getState();
    const targetEdges = getTargetEdges(allNodes, allEdges, id);
    const connectedInputs = new Set<string | null | undefined>();
    const connectedHandleList: string[] = [];
    const labelByHandle = new Map<string, { text: string; live: boolean; animated: boolean; sourceId: string; sourceHandle: string | null }>();
    const inputChannels = new Map<string, number>();
    const bySource = new Map<string, number>();
    let widest = 1;
    for (const e of targetEdges) {
      connectedInputs.add(e.targetHandle);
      // Keyed by source AND socket: two edges from the same node's different
      // sockets carry different widths (HSL's vec3 `out` vs its float `h`).
      const srcKey = `${e.source}|${e.sourceHandle ?? ''}`;
      let c = bySource.get(srcKey);
      if (c === undefined) {
        c = channelCount(e.source, e.sourceHandle, allNodes, allEdges);
        bySource.set(srcKey, c);
      }
      if (typeof e.targetHandle === 'string') {
        connectedHandleList.push(e.targetHandle);
        labelByHandle.set(e.targetHandle, {
          ...edgeValueLabel(e.source, allNodes, allEdges, e.sourceHandle),
          sourceId: e.source,
          sourceHandle: e.sourceHandle ?? null,
        });
        inputChannels.set(e.targetHandle, c);
      }
      widest = Math.max(widest, c);
    }
    return {
      connectedInputs,
      connectedHandleList,
      labelByHandle,
      inputChannels,
      inChannels: Math.min(widest, 4),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, edgeKey]);

  // Always price from the live (override-aware) table via nodeCostPoints, so a
  // measured benchmark dropped on the CostBar reprices this badge too — reading
  // `costVersion` re-runs the selector when the table changes. Non-chainable
  // nodes short-circuit inside nodeCostPoints (no edge scan); only variadic
  // arithmetic pays the O(E) operand count. The number result bails re-renders.
  const cost = useAppStore((s) => {
    void s.costVersion;
    return nodeCostPoints({ id, type: 'shader', position: { x: 0, y: 0 }, data } as ShaderFlowNode, s.edges);
  });
  const costColor = getCostColor(cost, costColorLow, costColorHigh);
  const headerTextColor = getContrastColor(costColor);
  const costTextColor = getCostTextColor(cost, costColorLow, costColorHigh);
  const costScale = getCostScale(cost);
  // Per-node box override (designer): minimum width. Frame style (corner
  // radius, border thickness) is fixed app-wide — only the color varies (category).
  const box = nodeBox(data.registryType);
  // The cost scale lives on an outer wrapper so the multi-channel stack layers
  // (siblings of the card, painted below it) scale together with the card.
  const wrapStyle = {
    position: 'relative',
    width: 'fit-content',
    transform: `scale(${costScale})`,
    transformOrigin: 'top left',
    // Category color for the selection outline (card + stacked-node frame).
  } as CSSProperties;
  const nodeStyle: CSSProperties = {
    background: 'var(--node-bg)',
    border: `${NODE_BORDER_WIDTH} solid ${catHex}`,
  };
  // Exact width override applied below, once we know whether a chainable node
  // has grown into list mode (which needs a comfortable width, not the compact
  // designer one).
  // Per-node text scale: multiplies header/value/edge-label font sizes via a
  // CSS variable (layout metrics like the 14px header stay fixed).
  const textScale = nodeTextScale(data.registryType);
  if (textScale !== 1) (nodeStyle as Record<string, string | number>)['--node-text-scale'] = textScale;
  const headerStyle: CSSProperties = { background: costColor };
  // Image node: param sockets follow the SAME opt-in exposedPorts rules as
  // the noise nodes — hidden until exposed via Node Settings (or auto-exposed
  // when an edge arrives). The rows layout otherwise ignores exposedPorts,
  // so filter the registry inputs here. Hidden inputs never mount as rows —
  // while a dragged wire is nearby (revealHidden) they render as floating
  // RevealSockets on the left edge instead, so the card layout never changes.
  const exposedInputs = useMemo(
    () => new Set(data.exposedPorts ?? []),
    [data.exposedPorts],
  );
  const effDef = useMemo(() => {
    // Data Stripes / Data Viz: the two RAMP ports are opt-in, everything else
    // (notably `signal`) is always on. Shared with every preview surface so a
    // palette tile cannot show a socket the dropped node lacks. Deliberately
    // NOT the imageNode treatment below — blanking defaultValues would delete
    // the inline swatches and filtering ALL inputs would drop `signal`.
    if (RAMP_COLOR_NODES.has(data.registryType)) return effectiveRampDef(def, exposedInputs);
    if (data.registryType !== 'imageNode') return def;
    // The tile/offset params are context-menu-only for the image node — they
    // never render as inline widgets. Leaving them in defaultValues makes
    // buildRows emit one empty setting row per param (dead space under the
    // thumbnail), so drop them; exposed ports still surface via `inputs`.
    const inputs = def.inputs.filter((inp) => exposedInputs.has(inp.id));
    return { ...def, inputs, defaultValues: {} };
  }, [def, data.registryType, exposedInputs]);
  const rows = useMemo(() => buildRows(effDef, data.dynamicOutputs), [effDef, data.dynamicOutputs]);

  // Connected input sockets + the chainable growth list — derived once per
  // edgeKey change (see graphInfo above).
  const connectedInputs = graphInfo.connectedInputs;
  const connectedHandleList = graphInfo.connectedHandleList;

  // A socket-growing node (variadic arithmetic, append) grows/shrinks its input
  // sockets as operands are wired. Whenever that count changes, React Flow must
  // re-measure the handles — their vertical anchors shift and a freshly added
  // socket has no measured bounds yet — or existing edges snap to stale
  // positions.
  const updateNodeInternals = useUpdateNodeInternals();
  const valuedHandleList = useMemo(() => Object.keys(data.values ?? {}), [data.values]);
  // `append` concatenates into a fixed-width vector, so its growth ceiling is
  // CHANNELS, not sockets: one wired vec3 already spends three of the four, and
  // the emitter trims whatever overflows. Without this the affordance kept
  // offering a socket a wire could land on and never reach the shader. The
  // arithmetic folds are unaffected — they consume every operand they take.
  const growSockets =
    revealGrowth &&
    !appendGrowthExhausted(def, connectedHandleList, valuedHandleList, (portId) =>
      graphInfo.inputChannels.get(portId),
    );
  const opSocketCount = growsOperands(def)
    ? effectiveInputs(def, connectedHandleList, growSockets, valuedHandleList).length
    : def.inputs.length;
  // The Image node's opt-in sockets re-measure on any exposed-set change (the
  // count alone can stay equal while the handle ids differ) — same idiom as
  // PreviewNode's exposedKey. The reveal flag is part of the key: floating
  // RevealSockets mount mid-drag and must enter React Flow's bounds map to
  // be snappable.
  // The exposed set is part of the key: micNode keeps all its inputs in
  // effDef, so without this React Flow would never re-measure when a socket
  // is ticked on or off and the new handle would report a stale position.
  const exposedKey =
    effDef.inputs.map((inp) => inp.id).join('|') +
    '#' + [...exposedInputs].sort().join(',') +
    (revealHidden ? '|R' : '');
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, opSocketCount, exposedKey, updateNodeInternals]);

  // A socket-growing node with 3+ operands renders as a vertical socket list
  // (the compact glyph-centered look only fits two). It keeps the SAME authored
  // width as the 2-op node — growth is vertical only, never wider.
  const chainListMode = growsOperands(def) && opSocketCount > 2;
  if (box.width) {
    // The authored width is the PREFERRED width, and `min-content` is the
    // floor: the node keeps its designed width whenever the content fits, and
    // widens only when something genuinely cannot — in practice a long
    // generated varName in the header, which no longer breaks mid-word (see
    // .node-base__title). Previously this pinned `minWidth` to the authored
    // width too, so an over-long title had nowhere to go but a third, fourth
    // and fifth row.
    nodeStyle.width = box.width;
    nodeStyle.minWidth = 'min-content';
  }

  // Multi-channel stacked-cards effect: the node stacks only when multi-channel
  // data ARRIVES on its inputs — the widest channel count across connected input
  // edges (mirrors TypedEdge's count). N channels read as N total cards: the
  // card itself plus N−1 offset layers. Source/constructor nodes (no
  // multi-channel input) never stack. Sockets stay single — consistency rule.
  // Channels arriving per connected input handle, and the widest across all of
  // them. Built in one pass: channelCount() runs a full upstream CPU eval, so
  // each distinct source is evaluated at most once (a node can have several
  // edges from one source, and every socket tooltip wants this number).
  const { inChannels, inputChannels } = graphInfo;

  /** Offset card layers behind the node body (channels − 1, so N-ch = N cards).
   *  z-index staggers downward (−1, −2, −3): deeper layers paint FIRST, so each
   *  shallower layer only covers the top of the one beneath and every layer's
   *  bottom strip stays visible. (Equal z would paint in DOM order and erase
   *  all but the deepest strip.) */
  const stackLayerCount = inChannels - 1;
  // While stacked, the card drops its own shadow so no shadow falls BETWEEN
  // cards — the DEEPEST layer casts the single group shadow instead. That is
  // also what makes selection work on a stack: selection is an elevation change
  // (2px -> 8px, see tokens.css), and putting it on the deepest layer lifts the
  // whole stack as one object. Banding the top card instead — which is what the
  // retired .node-base__stack-frame did with a ring — highlighted a part of a
  // thing the user selected whole.
  if (stackLayerCount > 0) nodeStyle.boxShadow = 'none';
  const stackLayers = stackLayerCount > 0
    ? [...Array(stackLayerCount).keys()].map((k) => (
        <div
          key={`stack-${k}`}
          className="node-base__stack"
          style={{
            transform: `translateY(${(k + 1) * STACK_STEP_Y}px)`,
            zIndex: -(k + 1),
            borderColor: catHex,
            // Reads the shared lift variable (NodeBase.css) rather than
            // branching on `selected` here, so the deepest layer follows HOVER
            // too — the wrapper publishes one value for both states and the
            // whole stack rises together.
            ...(k === stackLayerCount - 1
              ? { boxShadow: 'var(--fs-node-lift, var(--shadow-node))' }
              : null),
          }}
        />
      ))
    : null;

  const cardClass =
    `node-base${selected ? ' node-base--selected' : ''}` +
    `${stackLayerCount > 0 ? ' node-base--stacked' : ''}`;

  // The Slider's range input and the inline colour swatches (stripes/dataviz
  // lowColor/highColor) fire a change per pointermove FRAME, and every one
  // reaches updateNodeData -> an unconditional pushHistory -> a full-graph
  // structuredClone. Unbracketed, a one-second scrub pushes ~60 entries and
  // evicts the whole 50-entry undo stack (MAX_HISTORY), so Cmd+Z afterwards
  // steps through sub-pixel slider values instead of undoing real work.
  // Bracket the burst so it lands as ONE undo entry — the same fix
  // ColorNode.tsx:135-154 applies to the native colour picker. Deliberately
  // NOT inside handleChange: that writer also backs the DragNumberInput rows,
  // which already bracket their own drags, and a second bracket there would
  // open a 600 ms coalescing window on a single arrow-button click.
  const { bracket, closeBracket } = useHistoryBracket();

  const handleChange = useCallback(
    (key: string, raw: string) => {
      const num = parseFloat(raw);
      const value = isNaN(num) ? raw : num;
      updateNodeData(id, { values: { ...data.values, [key]: value } } as Partial<ShaderFlowNode['data']>);
    },
    [id, data.values, updateNodeData],
  );

  // Operator layout for 2-input socket-growing / glyph nodes (usesOperatorLayout
  // — glyph OR grows; `append` is the glyphless member, and gating this on the
  // glyph alone is what kept it two sockets wide forever). COMPACT (the default,
  // and the only mode for non-growing ops): the glyph sits BETWEEN the two inputs — `a`
  // above, `b` below — output centered on the right. A chainable arithmetic node
  // with 3+ operands switches to LIST mode: a vertical socket column (no glyph),
  // each row a value beside its socket, output vertically centered, body growing
  // with the operand count. See `chainListMode` above.
  if (usesOperatorLayout(def)) {
    // Chainable arithmetic grows past the two static ports: `effectiveInputs`
    // appends one empty grow-socket (the editable identity box) below the last
    // operand — but ONLY while `growSockets` is set (a wire is being dragged
    // near this node, and — for `append` — the vector still has a free
    // channel; see utils/appendCapacity). At rest it returns just the wired operands, so a fully
    // wired a+b stays the compact 2-op look instead of sprouting a dangling
    // socket. Non-chainable 2-input glyph nodes get their static [a, b] back.
    const ins = effectiveInputs(def, connectedHandleList, growSockets, valuedHandleList);
    const N = ins.length;
    const identity = def.chainIdentity ?? 0;
    const scale = nodeScale(data.registryType);
    const glyphPx = Math.round(34 * scale);
    // COMPACT (N=2): the classic glyph-between-two-inputs operator look — glyph
    // centered, values centered/designer-justified, designer socket overrides
    // honored. LIST (N≥3, chainable only): a vertical socket list — no glyph,
    // sockets evenly stacked, values left of their sockets, output centered, and
    // the body GROWS with N (the fixed designer height becomes a floor, not a
    // cap, so operands never spill past the card border).
    // List-mode rows sit 20% tighter than the classic 2-op spacing.
    const PITCH = chainListMode ? 19.2 : 25;
    const BODY_H = chainListMode
      ? Math.max((N - 1) * PITCH + 26, box.height ?? 52)
      : (box.height ?? Math.max(52, glyphPx + 10));
    // Value justification: centered in both modes (designer override may move
    // it on compact nodes) — numbers always sit in the middle of the node.
    const justify = chainListMode ? 'center' : nodeJustify(data.registryType);
    // Socket positions are px offsets from the body CENTER. Compact honors the
    // designer overrides (a −12 / b +12 / out 0); list ignores them and evenly
    // spaces every socket, output dead-center.
    const sockets = chainListMode ? {} : nodeSockets(data.registryType);
    const DEF_OFF_2 = [-12.5, 12.5];
    const offOf = (portId: string, i: number) =>
      sockets[portId] ?? (chainListMode ? -((N - 1) * PITCH) / 2 + i * PITCH : (DEF_OFF_2[i] ?? 0));
    const outOff = chainListMode ? 0 : (sockets['out'] ?? 0);
    return (
      <div style={wrapStyle}>
        {stackLayers}
        <div
          className={cardClass}
          style={nodeStyle}
        >
        {cost > 0 && <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>}

        <div className="node-base__header" style={headerStyle}>
          <span className="node-base__title" title={headerText} style={{ color: headerTextColor }}>
            {headerText}
          </span>
        </div>

        <div className="shader-node__op" style={{ height: BODY_H, ...(box.width ? { minWidth: 0 } : null) }}>
          {/* Operator glyph only in the compact 2-operand look; the vertical
              list identifies the op by its header name instead. */}
          {!chainListMode && hasNodeGlyph(data.registryType) && (
            <div className="shader-node__op-glyph">
              <NodeGlyph type={data.registryType} value={Number(data.values?.value ?? 0)} size={34} />
            </div>
          )}
          {ins.map((inp, i) => {
            const top = `${BODY_H / 2 + offOf(inp.id, i)}px`;
            const cls = `shader-node__op-val shader-node__op-val--${justify}`;
            // Values center via the --center class in both modes.
            const valStyle = { top };
            if (!connectedInputs.has(inp.id)) {
              // Unconnected operand — including the trailing grow slot — shows the
              // editable identity box (0 add/sub, 1 mul/div). Fill it (type or
              // wire) and the next operand slot appears below.
              return (
                <div key={`v-${inp.id}`} className={cls} style={valStyle}>
                  <DragNumberInput
                    compact
                    step={inp.dataType === 'int' ? 1 : undefined}
                    value={Number(data.values[inp.id] ?? def.defaultValues?.[inp.id] ?? identity)}
                    onChange={(v) => handleChange(inp.id, String(inp.dataType === 'int' ? Math.round(v) : v))}
                  />
                </div>
              );
            }
            const info = graphInfo.labelByHandle.get(inp.id) ?? null;
            return info ? (
              <div key={`r-${inp.id}`} className={cls} style={valStyle}>
                <LiveEdgeValue className="shader-node__edge-val" {...info} />
              </div>
            ) : null;
          })}
          {/* Handles anchor to the body (not the node top) so a wrapped,
              taller header never shifts socket positions. */}
          {/* No forced proximity tooltips here: operator cards (arithmetic,
              dot/cross/distance) have generic a/b operands whose floating
              labels are pure noise — the glyph-between-sockets look already
              says where to connect. Hover tooltips still work. */}
          {ins.map((inp, i) => (
            <TypedHandle
              key={`h-${inp.id}`}
              type="target"
              position={Position.Left}
              id={inp.id}
              dataType={inp.dataType}
              label={inp.label}
              style={{ top: `${BODY_H / 2 + offOf(inp.id, i)}px` }}
            />
          ))}
          {def.outputs[0] && (
            <TypedHandle
              type="source"
              position={Position.Right}
              id={def.outputs[0].id}
              dataType={def.outputs[0].dataType}
              label={def.outputs[0].label}
              style={{ top: `${BODY_H / 2 + outOff}px` }}
            />
          )}
        </div>
        </div>
      </div>
    );
  }

  // Rows layout: designer-moved sockets (sockets[id] / sockets['out']) detach
  // from their rows and position from the below-header region's center — the
  // same center-relative convention the operator layout uses. A detached
  // input's value widget follows its socket (op-val styling). Without an
  // override, sockets stay row-anchored (classic behavior).
  const sockOv = nodeSockets(data.registryType);
  const rowsOutOff = sockOv['out'];
  const rowsJustify = nodeJustify(data.registryType);
  const calcTop = (off: number) => `calc(50% ${off < 0 ? '-' : '+'} ${Math.abs(off)}px)`;

  return (
    <div style={wrapStyle}>
      {stackLayers}
      <div
        className={cardClass}
        style={nodeStyle}
      >
      {/* Cost badge above node */}
      {cost > 0 && <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>}

      {/* Header — colored by performance impact (cost) */}
      <div className="node-base__header" style={headerStyle}>
        <span className="node-base__title" title={headerText} style={{ color: headerTextColor }}>
          {headerText}
        </span>
      </div>

      {/* Data/Image node: source filename under the header (wraps if long).
          For an Image node the EXTENSION is the stored payload's, not the
          dropped file's — a re-encode routinely leaves a `.png` name on WebP
          or JPEG bytes, and the card must not assert a format the node
          doesn't hold. The title keeps the name as dropped. */}
      {(data.registryType === 'dataNode' || data.registryType === 'imageNode') && data.values?.fileName && (
        <div className="shader-node__file-name" title={String(data.values.fileName)}>
          {data.registryType === 'imageNode'
            ? displayImageFileName(data.values.fileName, data.values.imageB64)
            : String(data.values.fileName)}
        </div>
      )}

      {/* Image node: embedded-image thumbnail (validated URL only — see the
          imageThumbUrl memo). Sized by CSS, no shadow/hover of its own, so it
          never fights the socket-static or stack-shadow rules. */}
      {imageThumbUrl && (
        <img
          className="shader-node__image-thumb"
          src={imageThumbUrl}
          alt=""
          draggable={false}
          // Drop-time power-of-two snapping changes the stored pixel aspect
          // (1920×1080 → 2048×1024). That is invisible on the mesh — uv()
          // maps any texture across [0,1] — so the CARD must not be the one
          // place that shows a stretched picture. When the pre-snap
          // dimensions are recorded, the thumbnail is drawn at THEM.
          style={
            Number(data.values.srcWidth) > 0 && Number(data.values.srcHeight) > 0
              ? { aspectRatio: `${Number(data.values.srcWidth)} / ${Number(data.values.srcHeight)}`, objectFit: 'fill' }
              : undefined
          }
        />
      )}

      {/* Colormap node: the ramp it is currently set to. Reads the same
          gradient helper the settings menu and the picker use, so the card,
          the preview and the baked LUT can never show three different maps.
          The ramp is this node's ART, so the designer's dx/dy/scale apply to
          it (nodeArtStyle) — a purely visual transform that never moves
          sockets or rows. */}
      {data.registryType === 'colormap' && (
        <div
          className="shader-node__colormap-strip"
          title={getColormap(data.values?.map).label}
          style={{
            background: colormapGradientCss(
              getColormap(data.values?.map),
              Number(data.values?.reverse ?? 0) >= 0.5,
              Math.floor(Number(data.values?.levels ?? 0)),
            ),
            ...nodeArtStyle(data.registryType),
          }}
        />
      )}

      {/* Data Range carrying a user-authored formula. The SURPRISING state is
          the one that gets marked (the ClockNode `×speed` and noise `±1`
          precedent): a formula makes this node compute something the method
          name no longer describes, and a REJECTED formula is worse — the
          shader silently falls back to the method's own chain, so a shared
          `.fastshader` would render differently for the recipient with nothing
          on screen saying why. `ƒ!` is that missing signal; the tooltip carries
          the formula itself.

          Deliberately NOT mirrored into NodeVisual: `formula` is not a
          `defaultValues` key, so the replica (asset tiles, the node-editor
          overview, the designer stage) can never be handed one — mirroring it
          there would be unreachable code, not parity. */}
      {data.registryType === 'dataRange' && hasCustomFormula(data.values?.formula) && (
        <FormulaChip formula={data.values.formula as string} />
      )}

      {/* Below-header region: glyph + rows. Wrapping both lets a designer-moved
          output socket position absolutely against this region's center (same
          center-relative convention as the operator layout). A designer height
          is EXACT here too — shorter than content shrinks the node and the
          glyph/rows simply overflow (overflow stays visible; dx/dy places art). */}
      {/* Carries the class NodeVisual's mirror of this div already had — the
          Node Designer queries `.shader-node__region` to place its gesture
          overlays, and a hook that exists on only one half of a pair the spec
          says to change together is how the two drift. No CSS targets it. */}
      <div className="shader-node__region" style={{ position: 'relative', ...(box.height ? { height: box.height } : null) }}>
      {/* Glyph icon for the node, above the port rows. Values are never drawn on
          top of it — they live in the rows below, aligned with their sockets. */}
      {hasNodeGlyph(data.registryType) && (
        <div className="shader-node__glyph">
          <NodeGlyph type={data.registryType} value={Number(data.values?.value ?? 0)} size={30} />
        </div>
      )}

      {/* Port rows */}
      <div className="node-base__body">
        {rows.map((row, i) => {
          const inputConnected = row.input ? connectedInputs.has(row.input.id) : false;
          // Image node's `uv` port never shows an inline number: codegen falls
          // back to the uv() expression, so an editable scalar here would be a
          // dead widget (the edge-value label still renders when connected).
          const showInlineValue =
            row.input && !inputConnected && !row.settingKey && data.registryType !== 'imageNode';
          // Designer-moved input: its socket + value render detached (below),
          // so this row's left side stays empty.
          const inputMoved = row.input ? sockOv[row.input.id] != null : false;

          if (inputMoved) {
            return (
              <div key={i} className="node-base__row shader-node__row">
                <div className="shader-node__left" />
                <div className="shader-node__right">
                  {row.output && !(rowsOutOff != null && row.output === def.outputs[0]) && (
                    <TypedHandle
                      type="source"
                      position={Position.Right}
                      id={row.output.id}
                      dataType={row.output.dataType}
                      label={row.output.label}
                    />
                  )}
                </div>
              </div>
            );
          }

          return (
            <div key={i} className="node-base__row shader-node__row">
              {/* Left side: input handle + label + value */}
              <div className="shader-node__left">
                {row.input && (
                  <TypedHandle
                    type="target"
                    position={Position.Left}
                    id={row.input.id}
                    dataType={row.input.dataType}
                    label={row.input.label}
                    reveal={near}
                    channels={inputChannels.get(row.input.id)}
                  />
                )}
                {/* Image node: sockets are identified by their port label — the
                    editable numbers live in the context menu only (four bare
                    number boxes under the thumbnail read as noise). */}
                {row.input && data.registryType === 'imageNode' && (
                  <span className="shader-node__in-label">{portLabel(row.input.label, language)}</span>
                )}
                {/* Connected input → show the value(s) on the edge next to its socket */}
                {row.input && inputConnected && (() => {
                  const info = graphInfo.labelByHandle.get(row.input!.id) ?? null;
                  return info ? (
                    <LiveEdgeValue className="shader-node__edge-val" {...info} />
                  ) : null;
                })()}
                {/* Slider range input */}
                {data.registryType === 'slider' && row.settingKey === 'value' && (
                  <input
                    type="range"
                    className="shader-node__slider nodrag"
                    min={Number(data.values.min ?? def.defaultValues?.min ?? 0)}
                    max={Number(data.values.max ?? def.defaultValues?.max ?? 1)}
                    step={0.01}
                    value={Number(data.values.value ?? def.defaultValues?.value ?? 0.5)}
                    // bracket() FIRST: beginInteraction snapshots the state
                    // BEFORE the first mutation, so undo lands on the
                    // pre-scrub value (same order as DragNumberInput's own
                    // open-before-onChange and ColorNode's picker).
                    onChange={(e) => { bracket(); handleChange('value', e.target.value); }}
                    // Prompt closes. The hook's 600 ms idle timer is the
                    // GUARANTEE the bracket cannot be left open; these end the
                    // entry sooner. Not onPointerDown — a click on the track is
                    // a real change. NB while a bracket is open an unpaired
                    // close from a sibling DragNumberInput click-to-edit
                    // (min/max sit right beside this slider) would steal its
                    // depth and the flood would return until the idle timer
                    // re-arms — DragNumberInput now owns its own close.
                    onPointerUp={closeBracket}
                    onPointerCancel={closeBracket}
                    onKeyUp={closeBracket}
                    onBlur={closeBracket}
                    title={String(Number(data.values.value ?? 0.5).toFixed(2))}
                  />
                )}
                {/* Inline setting from defaultValues (imageNode: numbers live
                    in the context menu only — see the in-label above) */}
                {row.settingKey && row.settingType === 'number' && !inputConnected && data.registryType !== 'imageNode' && !(data.registryType === 'slider' && row.settingKey === 'value') && (
                  <DragNumberInput
                    compact
                    step={row.input?.dataType === 'int' ? 1 : undefined}
                    value={Number(data.values[row.settingKey] ?? def.defaultValues?.[row.settingKey] ?? 0)}
                    onChange={(v) => handleChange(row.settingKey!, String(row.input?.dataType === 'int' ? Math.round(v) : v))}
                  />
                )}
                {row.settingKey && row.settingType === 'color' && (
                  // The app-wide picker (palettes + recents + a native custom
                  // escape hatch). `history="bracket"`: this hex reaches the
                  // graph through handleChange -> updateNodeData, which
                  // pushHistory's unconditionally, and the picker owns the
                  // coalescing bracket for the per-frame stream its custom
                  // input still produces (this row used to bracket by hand).
                  <PaletteColorPicker
                    className="shader-node__input-color"
                    history="bracket"
                    value={String(data.values[row.settingKey] ?? def.defaultValues?.[row.settingKey] ?? '#ff0000')}
                    onPick={(hex) => handleChange(row.settingKey!, hex)}
                  />
                )}
                {row.settingType === 'vec3' && row.vecBaseKey && (
                  <span className="shader-node__vec-group">
                    {['x', 'y', 'z'].map((axis) => {
                      const k = `${row.vecBaseKey}_${axis}`;
                      return (
                        <DragNumberInput
                          key={axis}
                          compact
                          value={Number(data.values[k] ?? def.defaultValues?.[k] ?? 0)}
                          onChange={(v) => handleChange(k, String(v))}
                        />
                      );
                    })}
                  </span>
                )}
                {row.settingType === 'vec2' && row.vecBaseKey && (
                  <span className="shader-node__vec-group">
                    {['x', 'y'].map((axis) => {
                      const k = `${row.vecBaseKey}_${axis}`;
                      return (
                        <DragNumberInput
                          key={axis}
                          compact
                          value={Number(data.values[k] ?? def.defaultValues?.[k] ?? 0)}
                          onChange={(v) => handleChange(k, String(v))}
                        />
                      );
                    })}
                  </span>
                )}
                {/* Inline value for unconnected ports without defaultValues */}
                {showInlineValue && (
                  <DragNumberInput
                    compact
                    step={row.input?.dataType === 'int' ? 1 : undefined}
                    value={Number(data.values[row.input!.id] ?? 0)}
                    onChange={(v) => handleChange(row.input!.id, String(row.input?.dataType === 'int' ? Math.round(v) : v))}
                  />
                )}
              </div>

              {/* Right side: output handle (outputs[0] moves out of its row
                  when a designer socket override exists). Data nodes also show
                  each column's name (its CSV header) beside the socket. */}
              <div className="shader-node__right">
                {row.output && data.dynamicOutputs && (
                  <span className="shader-node__out-label">{row.output.label}</span>
                )}
                {row.output && !(rowsOutOff != null && row.output === def.outputs[0]) && (
                  <TypedHandle
                    type="source"
                    position={Position.Right}
                    id={row.output.id}
                    dataType={row.output.dataType}
                    label={row.output.label}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {/* Detached input sockets + their values (value follows its socket) */}
      {def.inputs.map((inp) => {
        const off = sockOv[inp.id];
        if (off == null) return null;
        const top = calcTop(off);
        const connected = connectedInputs.has(inp.id);
        const info = connected ? graphInfo.labelByHandle.get(inp.id) ?? null : null;
        return (
          <div key={`mv-${inp.id}`} style={{ display: 'contents' }}>
            <div className={`shader-node__op-val shader-node__op-val--${rowsJustify}`} style={{ top }}>
              {connected ? (
                info && (
                  <LiveEdgeValue className="shader-node__edge-val" {...info} />
                )
              ) : (
                <DragNumberInput
                  compact
                  step={inp.dataType === 'int' ? 1 : undefined}
                  value={Number(data.values[inp.id] ?? def.defaultValues?.[inp.id] ?? 0)}
                  onChange={(v) => handleChange(inp.id, String(inp.dataType === 'int' ? Math.round(v) : v))}
                />
              )}
            </div>
            <TypedHandle
              type="target"
              position={Position.Left}
              id={inp.id}
              dataType={inp.dataType}
              label={inp.label}
              reveal={near}
              style={{ top }}
            />
          </div>
        );
      })}
      {rowsOutOff != null && def.outputs[0] && (
        <TypedHandle
          type="source"
          position={Position.Right}
          id={def.outputs[0].id}
          dataType={def.outputs[0].dataType}
          label={def.outputs[0].label}
          style={{ top: calcTop(rowsOutOff) }}
        />
      )}
      </div>
      {/* Image node drag-reveal: hidden param sockets float on the left edge
          of the card (anchored to .node-base, NOT the rows region — the card
          layout never changes), named by their forced tooltips. */}
      {revealHidden && (
        <RevealSockets
          ports={def.inputs.filter((inp) => !exposedInputs.has(inp.id))}
        />
      )}
      </div>
    </div>
  );
});
