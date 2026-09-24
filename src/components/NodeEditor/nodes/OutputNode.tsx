import { memo, useCallback, useEffect, useMemo } from 'react';
import { valueNum } from '@/utils/valueCoerce';
import { Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import {
  assignMeshTargetsAcross,
  outputMaterials,
  dormantIndicesForPreview,
  storedValueEmits,
  materialTargetNames,
  channelHandle,
  isIndexSection,
  readModelSignature,
  sectionLabel,
  loadedModelOf,
  shownPreviewMesh,
  indexSectionsAwake,
  defaultSectionUnusedAcross,
  addedMaterialContributes,
  type IndexCoverage,
  MAX_PARTS,
} from '@/utils/outputMaterials';
import {
  defaultContributesOf,
  indexClaimLabels,
  meshNamesOf,
  outputBindingsKey,
  outputPlansFor,
} from './outputNodePlans';
import { isUntargetedOutput } from '@/utils/sdfPartition';
import { fillTemplate } from '@/utils/fillTemplate';
import { asOneHistoryEntry } from '@/utils/historyGesture';
import { t, portLabel, formatNodeLabel } from '@/i18n';
import type { AppNode } from '@/types';
import { OUTPUT_DEFAULT_EXPOSED } from '@/utils/exposedPorts';
import type { OutputFlowNode, OutputNodeData } from '@/types';
import { outputNodeValues } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { isActiveSinkSelector } from './activeSinkSelector';
import { getCostColor, getCostTextColor, getContrastColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
// Also pulls in ShaderNode.css transitively — the shared .shader-node__edge-val
// class (one font size for every number on a node) lives there.
import { useWiredLabels } from './ShaderNode';
import { LiveEdgeValue } from './LiveEdgeValue';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import { MeshTargetPicker } from './MeshTargetPicker';
import { IndexSectionChip } from './IndexSectionChip';
import { SECTION_SILENT_KEY, PARKED_KEY, formatSectionLabel, joinCapped } from './sectionLabelText';
import './OutputNode.css';
import { NODE_BORDER_WIDTH } from './nodeFrame';

/** Ports that belong to the pixel (fragment) shader section.
 *  Exported so the asset/overview card replica groups the channels the same
 *  way this node does (NodePreviewCard's OutputCardContent). */
export const PIXEL_PORTS = ['color', 'emissive', 'roughness', 'metalness', 'opacity', 'discard', 'normal', 'env'];
/** Ports that belong to the vertex shader section (see PIXEL_PORTS). */
export const VERTEX_PORTS = ['position'];
// Single source of truth lives with the shared exposedPorts rules; re-exported
// here for the existing importers (ShaderSettingsMenu, NodeEditor).
export { OUTPUT_DEFAULT_EXPOSED };

/** Channels that take a stored NUMBER when unwired, with the shown default
 *  (three's material defaults: roughness 1, metalness 0, opacity 1; discard
 *  and displacement default 0 = literal no-ops, so zero and absent read
 *  identically and neither emits). NB a non-zero discard is an UNCONDITIONAL
 *  cull (truthiness) — the whole mesh vanishes, by design. */
export const OUTPUT_FLOAT_VALUE_PORTS: Record<string, number> = {
  roughness: 1,
  metalness: 0,
  opacity: 1,
  discard: 0,
  position: 0,
};
/** Channels that take a stored HEX color when unwired, with the shown default:
 *  color WHITE and emissive/env BLACK (three's material defaults — black adds
 *  nothing), normal the FLAT TANGENT-SPACE NORMAL #8080ff — the "neutral up"
 *  every normal map is built on, and the color anyone authoring normals
 *  recognizes as "no perturbation". A stored env color is a legitimate
 *  constant ambient environment; an image wired to env stays the real IBL
 *  path. */
export const OUTPUT_COLOR_VALUE_PORTS: Record<string, string> = {
  color: '#ffffff',
  emissive: '#000000',
  normal: '#8080ff',
  env: '#000000',
};

/**
 * What an Output node contributing NOTHING actually renders.
 *
 * graphToCode's `channelEntries.length === 0` branch emits
 * `return vec3(1, 0, 0);` — a deliberate "you have not wired anything yet"
 * sentinel — so a fresh Output node really does paint the mesh RED, while the
 * Color row showed the WHITE above and told the user something the shader
 * contradicted.
 *
 * This is state-dependent rather than a flat recolour of the default, because
 * `#ffffff` is CORRECT the moment any other channel contributes: the return
 * becomes an object, `colorNode` is left undefined, and three's
 * MeshPhysicalNodeMaterial default (white) takes over. Wire only Roughness and
 * the mesh is white, not red — so both colours are right, in different states.
 */
export const OUTPUT_EMPTY_COLOR = '#ff0000';

// storedValueEmits moved to utils/outputMaterials — the red-fallback swatch
// below and outputDefaultContributes (the 0.6 single-mesh-fallback mirror)
// must share ONE notion of "this value emits".

/** What a TARGETED node's INERT preview socket says (owner decision D2). */
export const FIXED_SOCKET_KEY =
  'This material always contributes — it shades the meshes it names, whichever output drives the whole model';

/** Displacement may go negative / beyond 1; everything else is a 0-1 dial. */
const CLAMP01_PORTS = new Set(['roughness', 'metalness', 'opacity', 'discard']);

/** The cross-node plans omit a node with nothing to report, so every lookup
 *  below falls back to one of these. Module scope, not a fresh literal per
 *  render: they are `useMemo` results and a new identity would re-run every
 *  memo that reads them on every notify. */
const EMPTY_SECTIONS: ReadonlySet<number> = new Set<number>();
const EMPTY_COVERAGE: ReadonlyMap<number, IndexCoverage> = new Map<number, IndexCoverage>();

/** This node's own material index. One Output node is ONE material since the
 *  per-material split, and every channel is wired through its BARE handle —
 *  which is the id every saved edge already spells. The constant is here so
 *  the two `channelHandle(…)` reads below say WHY they pass a zero rather than
 *  looking like a leftover. */
const SELF = 0;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// The cross-node plans, the bindings key they are gated on, and the two
// per-notify selector helpers all live in `outputNodePlans.ts` — a zero-React
// module, so "computed ONCE for N cards" is an executable test rather than a
// source pin. Computed per instance they were O(N²): ~17 cards each running
// the same six plans over the same 17 nodes, ≈0.8 ms per binding change.

export const OutputNode = memo(function OutputNode({
  id,
  data,
  selected,
}: NodeProps<OutputFlowNode>) {
  const def = NODE_REGISTRY.get('output')!;
  const language = useAppStore((s) => s.language);
  // Is THIS node the active sink? A boolean selector, so a graph notify that
  // does not move the choice re-renders nothing (utils/sdfPartition.ts).
  const activeSel = useMemo(() => isActiveSinkSelector(id), [id]);
  const isActive = useAppStore(activeSel);
  const setActiveOutput = useAppStore((s) => s.setActiveOutput);
  // THIS node as an AppNode, for the shared predicates that take one. Read
  // from the props rather than the store so the card re-renders with its node.
  const selfNode = useMemo(() => ({ id, data } as unknown as AppNode), [id, data]);
  // The node's ONE material. `outputMaterials` still returns a list — a saved
  // `.fastshader` carries the folded shape and always will, so the unfold on
  // every restore path is what guarantees the length is 1 here — and material
  // 0 is this node's own `values` / `exposedPorts` / `materialSettings` plus
  // its binding.
  const materials = useMemo(() => outputMaterials(selfNode), [selfNode]);
  const material = materials[SELF];
  // The mesh list, as a cheap STRING: the inventory object would re-render
  // every Output on any preview report, and this needs only the names. The
  // picker is shown at all only for a MODEL — a primitive is one unnamed mesh,
  // so there is nothing to choose between and an empty dropdown would raise a
  // question the shader cannot answer.
  // ONE array for the whole canvas (`meshNamesOf`): this was mapped and joined
  // inside EVERY card's selector, i.e. 4 352 string allocations per notify on a
  // 256-mesh model, for a value that cannot differ between them. The key is the
  // cheap render signal; the array behind it keeps one identity, so every memo
  // that takes it stays put.
  const meshNamesKey = useAppStore((s) => meshNamesOf(s.previewMeshInventory).key);
  const meshNames = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => meshNamesOf(useAppStore.getState().previewMeshInventory).names,
    [meshNamesKey],
  );
  const hasMeshes = meshNames.length > 0;
  // A custom model that has not REPORTED yet (the swap window) must not put
  // sections to sleep — see dormantIndicesForPreview rule 1.
  const inventoryKnown = useAppStore((s) => !s.previewMesh || !!s.previewMeshInventory);
  // The loaded model's TRUSTED facts (`previewMesh.gltf`, computed by
  // createPreviewMesh) — what index sections sleep and mark against. Never
  // the sandbox's inventory: it is forgeable, and an index section's binding
  // is to a glTF MATERIAL, which only the trusted reader can see. The mesh
  // object's identity changes only when a model is loaded or removed. Read
  // only while the pane SHOWS it: a primitive picked in the Model menu reads
  // as no model, so index sections sleep rather than claim unshown meshes.
  const shownMesh = useAppStore(shownPreviewMesh);
  const loaded = useMemo(() => loadedModelOf(shownMesh), [shownMesh]);
  const gltfNotShown = useAppStore((s) => s.previewShowsModel === false && !!s.previewMesh && loadedModelOf(s.previewMesh).kind !== 'not-gltf');
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  // The header mixes into the card, and the card follows the theme
  // (getCostColor). `codeEditorTheme` is the app-wide dark switch; the store
  // field keeps its historical name.
  const darkTheme = useAppStore((s) => s.codeEditorTheme === 'vs-dark');
  const cost = data.cost ?? 0;
  const costColor = getCostColor(cost, costColorLow, costColorHigh, darkTheme);
  const costTextColor = getCostTextColor(cost, costColorLow, costColorHigh);
  const headerTextColor = getContrastColor(costColor);

  const exposedPorts = data.exposedPorts ?? OUTPUT_DEFAULT_EXPOSED;
  const exposedSet = new Set(exposedPorts);
  const values = outputNodeValues(data);

  /**
   * THE Output nodes the cross-node plans run over.
   *
   * `contributingOutputs`, not this node alone: a mesh can now be claimed by a
   * sibling NODE rather than a sibling section, so "is my claim shadowed",
   * "what does my index section still shade" and "does the module emit any part
   * at all" are all questions about the whole set — and the answers must be the
   * ones EMISSION reaches, which is exactly the set graphToCode walks. A
   * PARKED Output (untargeted, not the default) is deliberately outside it: it
   * contributes nothing, so it claims nothing and shadows nobody.
   */
  const outputsKey = useAppStore((s) => outputBindingsKey(s.nodes));
  /** The plans, computed ONCE for the canvas and shared by every card — the
   *  key is the change signal, the nodes are read imperatively behind it. */
  const plans = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => outputPlansFor(useAppStore.getState().nodes, loaded),
    [outputsKey, loaded],
  );
  // Destructured under the names the plans have always had, so every reader
  // below — and every source pin on them — speaks the same shape it always did.
  const { contributing, named: namedPlanAcross, index: indexPlanAcross, coverage: coverageAcross } = plans;
  /** Does this node own the module's TOP-LEVEL channels? Only the default can
   *  show the red sentinel, and only its block can read as "nothing left". */
  const isDefault = plans.defaultId === id;
  /** Untargeted but NOT the default: a whole-model variant that is parked
   *  behind another Output's active flag. It contributes nothing at all — so
   *  the red sentinel would be a lie (the module is not empty, this node is
   *  simply not in it) and "All meshes" would be a lie too. Its own mark. */
  const parked = isUntargetedOutput(selfNode) && !isDefault;
  const targets = useMemo(() => materialTargetNames(material), [material]);
  const indexSection = isIndexSection(material);

  /** This node's own shadowed sections. A node with none is ABSENT from the
   *  plan's map, so the empty set is the answer, not a missing one. */
  const shadowedSections = useMemo(
    () => namedPlanAcross.shadowed.get(id) ?? EMPTY_SECTIONS,
    [namedPlanAcross, id],
  );
  /** The model signature THIS node carries — what its own index binding is
   *  named against, and what its dormancy is judged on (both per node). */
  const signature = useMemo(() => readModelSignature(data), [data]);
  const indexDuplicates = useMemo(
    () => indexPlanAcross.duplicates.get(id) ?? EMPTY_SECTIONS,
    [indexPlanAcross, id],
  );
  /** Are this node's index sections awake on the loaded model (the exact
   *  signature rule; an unreadable glTF hides nothing)? */
  const indexAwake = indexSectionsAwake(signature, loaded);
  /** This node's slice of the cross-node coverage, section → coverage (the
   *  shape the chip reads): covered, overridden by a mesh section (the name
   *  claim wins), unused, or a duplicate. */
  const coverage = useMemo<ReadonlyMap<number, IndexCoverage>>(
    () => coverageAcross.get(id) ?? EMPTY_COVERAGE,
    [coverageAcross, id],
  );
  /** Does the DEFAULT shade nothing of the model on screen — every mesh taken
   *  by another Output? Marks its block instead of leaving it looking like a
   *  second Output whose sockets do nothing (see `defaultSectionUnused`).
   *
   *  Gated on `isDefault` INSIDE the memo — which is the whole condition it is
   *  read under — so on a 16-material import sixteen of the seventeen cards
   *  skip a walk whose answer only one of them can ever display. */
  const defaultUnused = useMemo(
    () => isDefault && defaultSectionUnusedAcross(meshNames, contributing, namedPlanAcross, coverageAcross),
    [isDefault, meshNames, contributing, namedPlanAcross, coverageAcross],
  );
  /** The double claim on the NAME side: mesh → the label of the material
   *  section that also covers it, for the picker's row titles. Built across
   *  EVERY contributing node, so a mesh an import-built sibling shades is
   *  named here even though this node holds no index section of its own. */
  const indexHints = indexClaimLabels(plans, language);

  /**
   * Set which meshes THIS node shades — taking each of them away from every
   * other Output NODE, because a mesh belongs to exactly one material.
   *
   * A MULTI-NODE write, which is the whole difference from the stacked shape:
   * `updateNodeData` patches one node, so the move would have to be two writes
   * and Cmd+Z would step through a half-assigned state where two Outputs both
   * claim the mesh. One `setNodes` inside one `asOneHistoryEntry` instead.
   *
   * The no-op guard sits OUTSIDE the bracket: `beginInteraction` snapshots AND
   * clears `future` up front, so wrapping a write that changes nothing would
   * cost an undo entry and destroy the redo stack.
   */
  const setMeshTargets = useCallback(
    (names: string[]) => {
      const state = useAppStore.getState();
      const next = assignMeshTargetsAcross(state.nodes, id, names);
      if (next === state.nodes) return;
      asOneHistoryEntry(() => { useAppStore.getState().setNodes(next); });
    },
    [id],
  );

  // The Output node opts out of ALL drag-proximity behavior: no hidden-channel
  // reveal (channels are exposed only via the shader settings menu, or
  // auto-exposed when an edge arrives through sync/import) and no forced
  // name-tooltips (its rows already carry permanent labels).

  // What is arriving on each wired channel, keyed by the channel HANDLE — all
  // of them BARE now, one node being one material. The two-step cheap-string
  // subscription (and the unwrapped-edge rule that keeps a collapsed feeder
  // from degrading a row to a grey ellipsis) lives in the hook.
  const wiredLabels = useWiredLabels(id);
  const anyWired = wiredLabels.size > 0;

  /** Does this node's own material set anything at all? */
  const selfContributes = useMemo(
    () => addedMaterialContributes(material, anyWired),
    [material, anyWired],
  );

  /**
   * True when the MODULE contributes no channel at all, i.e. exactly
   * graphToCode's red-fallback branch (`return vec3(1, 0, 0);`). Only then does
   * the unwired Color row show RED — see OUTPUT_EMPTY_COLOR.
   *
   * Scoped to the DEFAULT node, and asked across every contributing Output.
   * Both halves matter after the split: a targeted sibling's `parts` entry
   * takes the object return, so the default's Color is then three's white and
   * not the sentinel; and a PARKED or TARGETED node never emits the sentinel at
   * all, whatever its own channels do.
   */
  const emitsNothing = useMemo(() => {
    if (!isDefault) return false;
    if (anyWired) return false;
    if (namedPlanAcross.entries.length > 0 || indexPlanAcross.entries.length > 0) return false;
    return !Object.keys(values).some(
      (k) => exposedSet.has(k) && storedValueEmits(k, values[k]),
    );
    // exposedSet/values are derived from `data` each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDefault, anyWired, namedPlanAcross, indexPlanAcross, data]);

  // A node whose EVERY named mesh is absent from the loaded model is DORMANT —
  // rendered COMPACT (header plus the chip below) rather than deleted: drop a
  // different model and the multimesh setup clears itself from the canvas; load
  // the matching model again and the node is back, wiring intact, because
  // nothing but visibility ever changed. Two context rules ride along (see
  // dormantIndicesForPreview): an unreported model hides nothing, and the 0.6
  // loader's single-mesh fallback exempts the module's FIRST named part, which
  // is actively painting the screen — `firstNamedHere` is what keeps that rule
  // about the module rather than letting every targeted node exempt itself.
  const defaultContributes = useAppStore((s) => defaultContributesOf(s.nodes, s.edges));
  const firstNamedHere = plans.firstNamedId === id;
  const dormant = useMemo(
    () => dormantIndicesForPreview(materials, {
      meshNames,
      inventoryKnown,
      defaultContributes,
      indexSectionsAwake: indexAwake,
      firstNamedHere,
    }),
    [materials, meshNames, inventoryKnown, defaultContributes, indexAwake, firstNamedHere],
  );
  const nodeDormant = dormant.has(SELF);

  /** Write this node's stored channel values. Read the CURRENT node
   *  imperatively rather than from the render closure, so two quick edits (a
   *  scrub landing while a picker is open) cannot drop the first. */
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const readValues = useCallback((): Record<string, string | number> => {
    const node = useAppStore.getState().nodes.find((n) => n.id === id);
    // `outputNodeValues`, not `?? {}`: nothing coerces an Output's node-level
    // `values`, and `clearChannelValue` below asks `channel in current`, which
    // THROWS on a primitive out of a `.fastshader`.
    return outputNodeValues(node?.data);
  }, [id]);

  /** Clear a channel's stored value — back to "default / none": the widget
   *  shows the channel default again and the channel stops emitting. */
  const clearChannelValue = useCallback(
    (channel: string) => {
      const current = readValues();
      if (!(channel in current)) return;
      const { [channel]: _dropped, ...rest } = current;
      updateNodeData(id, { values: rest } as Partial<OutputNodeData>);
    },
    [id, readValues, updateNodeData],
  );

  const setChannelValue = useCallback(
    (channel: string, value: string | number) => {
      updateNodeData(id, { values: { ...readValues(), [channel]: value } } as Partial<OutputNodeData>);
    },
    [id, readValues, updateNodeData],
  );

  // Tell React Flow to re-measure handles whenever the RENDERED port set
  // changes (a settings toggle, or the node falling asleep). Without this,
  // dynamically mounted handles (e.g. `emissive` after the user toggles it on)
  // aren't in React Flow's bounds map, so any edge connected to them silently
  // fails to render until the page is reloaded.
  //
  // A DORMANT node renders nothing but its header and chip, so its WHOLE
  // handle block is unmounted — the key must change when it sleeps or WAKES,
  // or the remounted handles are never re-measured and every wire restored with
  // the node stays undrawn until a reload. '~' cannot collide with a joined
  // port list (port ids are word characters).
  const updateNodeInternals = useUpdateNodeInternals();
  const exposedKey = nodeDormant ? '~' : exposedPorts.join('|');
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, exposedKey, updateNodeInternals]);

  // Only permanently exposed channels render (as rows) — no drag reveal here.
  const sectionPorts = (ids: string[]) =>
    def.inputs.filter((p) => ids.includes(p.id) && exposedSet.has(p.id));
  const pixel = sectionPorts(PIXEL_PORTS);
  const vertex = sectionPorts(VERTEX_PORTS);

  /**
   * A TARGETED node that sets nothing: no wire on any of its handles and no
   * emitting stored value on an exposed channel, so `buildShaderModule` drops
   * its part and the meshes it names keep exactly what they had.
   *
   * MARKED rather than prevented: it is the state a freshly targeted Output
   * starts in, and the mark is what stops "point an Output at a mesh" from
   * reading as an assignment that failed (owner, 2026-09-18). It clears itself
   * the moment anything on the node emits. The DEFAULT is never in this state —
   * an Output contributing nothing emits the red sentinel, which `emitsNothing`
   * marks instead — and neither is a PARKED node, which has its own mark.
   */
  const silent = !isDefault && !parked && !selfContributes;

  /** The right-hand cell of a row: the incoming value when wired (read-only,
   *  plain text, blue when live — a fill means "editable", plain text means
   *  "derived"); otherwise the channel's stored-value widget, when it has
   *  one. Same editable-vs-derived contract as every ShaderNode row. */
  const rowWidget = (portId: string) => {
    const wired = wiredLabels.get(channelHandle(SELF, portId));
    if (wired) {
      return (
        <LiveEdgeValue className="shader-node__edge-val output-node__val" {...wired} />
      );
    }
    if (portId in OUTPUT_COLOR_VALUE_PORTS) {
      const stored = values[portId];
      // On a material that emits nothing, the shader's real Color is the red
      // fallback — show that instead of a white the preview contradicts.
      const channelDefault =
        portId === 'color' && emitsNothing
          ? OUTPUT_EMPTY_COLOR
          : OUTPUT_COLOR_VALUE_PORTS[portId];
      return (
        <PaletteColorPicker
          className="output-node__val"
          // A stored channel colour IS the graph — it emits `color(0x…)` — so
          // this site is undoable and takes the bracket.
          history="bracket"
          // A SILENT targeted node emits no part at all, and a PARKED one is
          // not in the module — so their unwired channels paint nothing. The
          // UNSET swatch (hollow, slashed) says that, where the channel default
          // promised a white the preview never paints. The moment the node
          // emits, every row goes back to showing what it really renders for an
          // unset channel.
          value={typeof stored === 'string' ? stored : ((silent || parked) ? '' : channelDefault)}
          title={silent ? t(SECTION_SILENT_KEY, language) : parked ? t(PARKED_KEY, language) : undefined}
          clearColor={channelDefault}
          onClear={() => clearChannelValue(portId)}
          onPick={(hex) => setChannelValue(portId, hex)}
        />
      );
    }
    if (portId in OUTPUT_FLOAT_VALUE_PORTS) {
      const stored = valueNum(values[portId]);
      const shown = Number.isFinite(stored) && values[portId] !== undefined && values[portId] !== null
        ? stored
        : OUTPUT_FLOAT_VALUE_PORTS[portId];
      return (
        <DragNumberInput
          compact
          className="output-node__val"
          value={shown}
          step={0.05}
          onChange={(v) =>
            setChannelValue(portId, CLAMP01_PORTS.has(portId) ? clamp01(v) : v)
          }
        />
      );
    }
    return null;
  };

  // Widget FIRST, label after — the ShaderNode row anatomy (socket, then the
  // value box beside it); the label trails like an out-label would.
  const renderRow = (port: (typeof def.inputs)[number]) => {
    const handle = channelHandle(SELF, port.id);
    return (
      <div key={handle} className="output-node__row">
        <TypedHandle
          type="target"
          position={Position.Left}
          id={handle}
          dataType={port.dataType}
          label={port.label}
        />
        {rowWidget(port.id)}
        <span className="output-node__port-label">{portLabel(port.label, language)}</span>
      </div>
    );
  };

  // An EARLIER-ranked Output already names every one of these meshes, so the
  // first-claim rule shadows this one entirely. A duplicate only ever ARRIVES
  // (from a hand-edited or foreign file; the picker MOVES a mesh), so the state
  // is legal — but a node that looks live and contributes nothing is precisely
  // what nobody would think to report, hence the mark. Read from the SAME plans
  // emission uses: `planNamedPartsAcross` over names, `planIndexPartsAcross`
  // over glTF indices.
  const shadowed = indexSection ? indexDuplicates.has(SELF) : shadowedSections.has(SELF);
  // The picker appears once there is something to choose between, and stays
  // visible if this node already names a mesh: reopening a graph without its
  // model must not strand a target the node no longer shows (it still emits).
  //
  // A PARKED node shows it whatever the model situation — the picker IS where
  // that mark and its explanation live, and parking is reachable with no model
  // at all (two plain Outputs on a primitive, one active). Without this the
  // node would dim its rows and say nothing about why. The ordinary
  // single-Output document is untouched, since one Output alone is never parked.
  //
  // `shownMesh` is why a MODEL alone is enough, and it is the whole fix for a
  // GLB import: `hasMeshes` reads the SANDBOX inventory, which
  // `commitGlbImport → setPreviewMesh` has just NULLED, and which can only come
  // back from the rebuilt preview iframe once it has parsed the model and
  // posted its mesh report — the 200 ms code debounce plus an A-Frame boot
  // plus a multi-mesh glTF parse, easily seconds on a large file. So the
  // default Output rendered with NO mesh row at all for that whole window, and
  // permanently when the report never comes (no usable mesh name, or the Model
  // menu switched to a primitive). The row is now present the moment a model is
  // ON SCREEN, and fills with names when the report lands.
  //
  // It gates VISIBILITY only. The option list is still the inventory's alone —
  // `meshInventory` is the one source of mesh TARGETS, and the glTF reader's
  // PREDICTED names are display-only by construction (they may be uncertain),
  // so offering them here would make a guess emittable.
  const showMeshRow = hasMeshes || !!shownMesh || targets.length > 0 || indexSection || parked;

  // The dormant chip speaks about the two bindings separately: a NAME binding
  // sleeps because the loaded model lacks its meshes, an INDEX binding because
  // the loaded model is not the glTF it was built from (or none is loaded).
  const dormantTitle = !nodeDormant ? '' : indexSection
    ? `${loaded.kind === 'gltf'
      ? t('Material sections for a model with other materials — the materials of the loaded model differ. They still emit, and return (wiring intact) when that model is loaded', language)
      : gltfNotShown
        ? t('Material sections for a glTF model — the preview is showing a different shape. They still emit, and return (wiring intact) when that model is shown', language)
        : t('Material sections for a glTF model — none is loaded. They still emit, and return (wiring intact) when that model is loaded', language)}: ${formatSectionLabel(sectionLabel(materials, SELF, signature), language)}`
    : `${t('Mesh materials for another model — the loaded model has none of their meshes. They still emit, and their sections return (wiring intact) when a matching model is loaded', language)}: ${joinCapped(targets)}`;

  return (
    <div
      className={`output-node ${selected ? 'output-node--selected' : ''}${isActive ? '' : ' output-node--inactive'}${nodeDormant ? ' output-node--dormant' : ''}`}
      style={{ background: 'var(--node-bg)', border: `${NODE_BORDER_WIDTH} solid var(--cat-output)` }}
    >
      {/* Bare number, matching every ShaderNode badge — the unit is spelled out
          once on the CostBar meter rather than repeated on every node. */}
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>
          {cost}
        </span>
      )}

      {/* Main header — the node's name and nothing else. Which mesh this node
          shades is stated by the picker, the first row UNDER this header.
          The `_01` suffix appears only on a document with SEVERAL Outputs, in
          emit order: one node is one material, and this header is the registry
          LABEL (not a ShaderNode's generated var name), so without it a GLB
          import is a column of cards all headed "Output". Display only — see
          `outputOrdinals`. */}
      <div className="output-node__header" style={{ background: costColor }}>
        <span className="output-node__title" style={{ color: headerTextColor }}>
          {formatNodeLabel(def.label, 'output', language, false)}{plans.ordinals.get(id) ?? ''}
        </span>
      </div>

      {/* A DORMANT node renders COMPACT: header plus the "nothing silently
          vanished" chip, its channel rows and every one of their handles
          UNMOUNTED — so its wires stay invisible exactly as a dormant section's
          did, and the node is still visibly THERE with its title naming the
          meshes it waits for. Never hidden: the wiring behind it must not read
          as having been deleted. */}
      {nodeDormant ? (
        // The count is always ONE — a node is one material — so both keys are
        // used in the singular they already had. Kept as the counted sentence
        // rather than reworded: it is exactly what a node with one sleeping
        // section said before the split, in both languages.
        <div className="output-node__dormant" title={dormantTitle}>
          {indexSection
            ? fillTemplate(t('{n} material section for another model', language), { n: 1 })
            : <>1 {t('mesh material for another model', language)}</>}
        </div>
      ) : (
        <div
          className={`output-node__material${defaultUnused ? ' output-node__material--unused' : ''}${parked ? ' output-node__material--parked' : ''}`}
        >
          {/* The node's output socket — the decorative anchor its PreviewLink
              wire leaves from, and (on an UNTARGETED node) the ACTIVATION
              control: several output nodes may coexist, exactly one drives
              (utils/sdfPartition.ts `activeSink`), and clicking the socket
              makes THIS node the active one.

              D2 — on a TARGETED node it is INERT: a solid anchor, not a
              `<button>`, with no `aria-pressed`. Activation only means
              something among UNTARGETED Outputs (a targeted one contributes
              whatever the flag says), so a click here would write a flag
              `normalizeActiveOutput` then strips — and, worse, would silently
              stop the whole-model material emitting. Solid because the node
              always contributes; hollow only ever means "parked". It keeps
              `nodrag` and stops its pointerdown so a press does nothing at all
              rather than dragging the node from what looks like a port, and it
              keeps real pointer-events so its `title` can open (a `title` on a
              `pointer-events: none` element never fires).

              NOT a React Flow Handle either way: the Output has no outputs and
              a real handle would invite a wire that can never land. */}
          {isUntargetedOutput(selfNode) ? (
            <button
              type="button"
              className={`output-node__preview-socket nodrag${isActive ? '' : ' output-node__preview-socket--inactive'}`}
              aria-pressed={isActive}
              aria-label={t(isActive ? 'Rendering this output' : 'Render this output', language)}
              title={t(isActive ? 'This output drives the preview' : 'Click to render this output instead', language)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); setActiveOutput(id); }}
            />
          ) : (
            <span
              className="output-node__preview-socket output-node__preview-socket--fixed nodrag"
              title={t(FIXED_SOCKET_KEY, language)}
              onPointerDown={(e) => e.stopPropagation()}
            />
          )}

          {showMeshRow && (
            <div className="output-node__mesh-row">
              {/* An index-bound node has no mesh list to edit — the MODEL
                  decides which meshes wear its material — so it shows a
                  read-only chip (inside the picker's width cap; the name is
                  attacker-supplied). */}
              {indexSection ? (
                <IndexSectionChip
                  label={formatSectionLabel(sectionLabel(materials, SELF, signature), language)}
                  duplicate={shadowed}
                  coverage={coverage.get(SELF)}
                />
              ) : (
                <MeshTargetPicker
                  meshNames={meshNames}
                  selected={targets}
                  // EVERY plain Output offers "All meshes (default)": unticking
                  // everything is the only way back from a targeted node to a
                  // whole-model one.
                  allowDefault
                  shadowed={shadowed}
                  unused={defaultUnused}
                  silent={silent}
                  parked={parked}
                  maxNames={MAX_PARTS}
                  indexClaimed={indexHints}
                  onChange={setMeshTargets}
                />
              )}
            </div>
          )}

          <div className="output-node__section">
            <div className="output-node__section-label">{t('Pixel Shader', language)}</div>
            <div className="output-node__ports">{pixel.map(renderRow)}</div>
          </div>

          {vertex.length > 0 && (
            <>
              <div className="output-node__subdivider" />
              <div className="output-node__section">
                <div className="output-node__section-label">{t('Vertex Shader', language)}</div>
                <div className="output-node__ports">{vertex.map(renderRow)}</div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
});
