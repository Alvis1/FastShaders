import { memo, useCallback, useEffect, useMemo } from 'react';
import { Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import {
  assignMeshTargets,
  outputMaterials,
  materialTargetNames,
  materialExposedPorts,
  channelHandle,
  shiftMaterialHandles,
  MAX_ADDED_MATERIALS,
  type OutputMaterial,
} from '@/utils/outputMaterials';
import { removeEdgesForPort } from '@/utils/edgeUtils';
import { asOneHistoryEntry } from '@/utils/historyGesture';
import { t } from '@/i18n';
import type { AppNode } from '@/types';
import { OUTPUT_DEFAULT_EXPOSED } from '@/utils/exposedPorts';
import type { OutputFlowNode, OutputNodeData } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostTextColor, getContrastColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
// Also pulls in ShaderNode.css transitively — the shared .shader-node__edge-val
// class (one font size for every number on a node) lives there.
import { edgeValueLabel } from './ShaderNode';
import { LiveEdgeValue } from './LiveEdgeValue';
import { getTargetEdges } from '@/engine/cpuEvaluator';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import { MeshTargetPicker } from './MeshTargetPicker';
import './OutputNode.css';

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

/** Stored channel values that graphToCode deliberately treats as no-ops and
 *  emits NOTHING for, so they do not make the node "contribute" (see the
 *  Output-node stored-value contract in CLAUDE.md: zero discard/displacement
 *  and the identity normal texel are indistinguishable from an absent key). */
function storedValueEmits(channel: string, v: unknown): boolean {
  if (v === undefined || v === null || v === '') return false;
  if (channel === 'discard' || channel === 'position') return Number(v) !== 0;
  if (channel === 'normal') return String(v).toLowerCase() !== '#8080ff';
  return true;
}

/** Displacement may go negative / beyond 1; everything else is a 0-1 dial. */
const CLAMP01_PORTS = new Set(['roughness', 'metalness', 'opacity', 'discard']);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export const OutputNode = memo(function OutputNode({
  id,
  data,
  selected,
}: NodeProps<OutputFlowNode>) {
  const def = NODE_REGISTRY.get('output')!;
  const language = useAppStore((s) => s.language);
  // Every material on this node, material 0 (the default) first. Read from
  // `data` rather than the store so a section re-renders with its node.
  const materials = useMemo(
    () => outputMaterials({ id, data } as unknown as AppNode),
    [id, data],
  );
  // The mesh list, as a cheap STRING: the inventory object would re-render
  // every Output on any preview report, and this needs only the names. The
  // picker is shown at all only for a MODEL — a primitive is one unnamed mesh,
  // so there is nothing to choose between and an empty dropdown would raise a
  // question the shader cannot answer.
  const meshNamesKey = useAppStore(
    // NUL-joined, not space-joined: an OBJ mesh name may legally contain
    // spaces (they skip three's sanitizer), while `isUsableMeshName` refuses
    // control characters — so this separator cannot occur inside a name.
    (s) => (s.previewMeshInventory?.meshes ?? []).map((m) => m.name).join('\u0000'),
  );
  const meshNames = useMemo(
    () => (meshNamesKey ? meshNamesKey.split('\u0000') : []),
    [meshNamesKey],
  );
  const hasMeshes = meshNames.length > 0;
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const cost = data.cost ?? 0;
  const costColor = getCostColor(cost, costColorLow, costColorHigh);
  const costTextColor = getCostTextColor(cost, costColorLow, costColorHigh);
  const headerTextColor = getContrastColor(costColor);

  const exposedPorts = data.exposedPorts ?? OUTPUT_DEFAULT_EXPOSED;
  const exposedSet = new Set(exposedPorts);
  const values = (data as OutputNodeData).values ?? {};

  /** Write the ADDED materials back (material 0 lives in the node's fields). */
  const setAddedMaterials = useCallback(
    (next: OutputMaterial[]) => {
      updateNodeData(id, {
        materials: next.length > 0 ? next : undefined,
      } as Partial<OutputNodeData>);
    },
    [id, updateNodeData],
  );

  /** Read the CURRENT added materials imperatively — `data` in a callback
   *  closure is a snapshot, and two rapid edits would drop the first. */
  const readAdded = useCallback((): OutputMaterial[] => {
    const node = useAppStore.getState().nodes.find((n) => n.id === id);
    const raw = (node?.data as { materials?: unknown } | undefined)?.materials;
    return Array.isArray(raw) ? [...(raw as OutputMaterial[])] : [];
  }, [id]);

  /**
   * Add a material for the first mesh nothing has claimed yet.
   *
   * Seeded with a real target rather than an empty one: a material with no mesh
   * means nothing (material 0 is already the default), it would be dropped by
   * the sanitizer on the next reload, and it cannot emit — so offering one
   * would be offering a section that silently disappears.
   *
   * The "+ Add mesh" button still only ever mints an UNCLAIMED target, even
   * though the pickers below accept a duplicate: a duplicate is a deliberate
   * intermediate step in a swap, never a sensible thing to create out of
   * nothing (emission shadows it, so the new section would arrive inert).
   */
  const claimedNames = useMemo(
    () => new Set(materials.flatMap((m) => materialTargetNames(m))),
    [materials],
  );
  const canAddMaterial =
    materials.length - 1 < MAX_ADDED_MATERIALS
    && meshNames.some((n) => !claimedNames.has(n));

  const addMaterial = useCallback(() => {
    const added = readAdded();
    if (added.length >= MAX_ADDED_MATERIALS) return;
    const node = useAppStore.getState().nodes.find((n) => n.id === id);
    const claimed = new Set(
      (node ? outputMaterials(node) : added).flatMap((m) => materialTargetNames(m)),
    );
    const free = meshNames.find((n) => !claimed.has(n));
    if (!free) return;
    setAddedMaterials([...added, { meshTargets: [free] }]);
  }, [id, readAdded, meshNames, setAddedMaterials]);

  /**
   * Set which meshes a material shades — taking each of them away from every
   * other material, because a mesh belongs to exactly one.
   *
   * ONE `updateNodeData`, so the move is one undo entry: material 0's targets
   * are a NODE field while the rest ride `materials`, and writing them
   * separately would make Cmd+Z step through a half-assigned state where two
   * materials briefly claim the same mesh.
   *
   * Material 0's targets stay on the node rather than getting a slot in the
   * array: material 0 IS the node's own channel state, and an array slot would
   * make every single-material document carry a `materials` key it never needed
   * — the one thing keeping saved graphs and exported shaders byte-identical.
   */
  const setMaterialTargets = useCallback(
    (index: number, names: string[]) => {
      const node = useAppStore.getState().nodes.find((n) => n.id === id);
      if (!node) return;
      const next = assignMeshTargets(outputMaterials(node), index, names);
      const [first, ...added] = next;
      const firstNames = first.meshTargets ?? [];
      updateNodeData(id, {
        meshTargets: firstNames.length > 0 ? firstNames : undefined,
        meshTarget: undefined,
        materials: added.length > 0 ? added : undefined,
      } as Partial<OutputNodeData>);
    },
    [id, updateNodeData],
  );

  /**
   * Remove a material, its edges with it.
   *
   * The edges must go in the SAME history entry: dropping the material alone
   * would leave wires pointing at handles that no longer mount, which React
   * Flow keeps in the store and still emits code for — an invisible edge
   * feeding a material the node no longer shows.
   *
   * Materials after it shift down, so their handles are renamed too — otherwise
   * removing the first of three would strand material 3's wiring on a `m3:`
   * handle that now belongs to nothing.
   */
  const removeMaterial = useCallback(
    (index: number) => {
      asOneHistoryEntry(() => {
        const added = readAdded();
        const k = index - 1;
        if (!added[k]) return;
        for (const port of def.inputs) {
          removeEdgesForPort(id, channelHandle(index, port.id));
        }
        // Materials after this one renumber, so their handles move with them.
        const state = useAppStore.getState();
        const renamed = shiftMaterialHandles(state.edges, id, index);
        if (renamed !== state.edges) state.setEdges(renamed);
        added.splice(k, 1);
        setAddedMaterials(added);
      });
    },
    [id, def.inputs, readAdded, setAddedMaterials],
  );

  // The Output node opts out of ALL drag-proximity behavior: no hidden-channel
  // reveal (channels are exposed only via the shader settings menu, or
  // auto-exposed when an edge arrives through sync/import) and no forced
  // name-tooltips (its rows already carry permanent labels). Hover tooltips
  // still work.

  // What is arriving on each wired channel — the same two-step cheap-string
  // subscription ShaderNode/MicNode use: fold the labels into ONE primitive
  // string so a position-only graph notify bails on Object.is, then rebuild
  // the map imperatively from getState(). getTargetEdges, NOT raw s.edges:
  // it returns UNWRAPPED edges, so a feeder inside a collapsed group reports
  // its REAL producer -- the raw boundary edge's source is the group id,
  // which has no registry def and would degrade every affected row to a
  // grey ellipsis the moment the group collapses (the trap documented at
  // getTargetEdges' definition).
  const edgeKey = useAppStore((s) => {
    let key = '';
    for (const e of getTargetEdges(s.nodes, s.edges, id)) {
      if (typeof e.targetHandle !== 'string') continue;
      const l = edgeValueLabel(e.source, s.nodes, s.edges, e.sourceHandle);
      key += `${e.targetHandle}\u0000${e.sourceHandle ?? ''}\u0000${l.text}\u0000${l.live ? 1 : 0}${l.animated ? 1 : 0}\u0001`;
    }
    return key;
  });
  const wiredLabels = useMemo(() => {
    const { nodes, edges } = useAppStore.getState();
    const m = new Map<string, { text: string; live: boolean; animated: boolean; sourceId: string; sourceHandle: string | null }>();
    for (const e of getTargetEdges(nodes, edges, id)) {
      if (typeof e.targetHandle !== 'string') continue;
      m.set(e.targetHandle, { ...edgeValueLabel(e.source, nodes, edges, e.sourceHandle), sourceId: e.source, sourceHandle: e.sourceHandle ?? null });
    }
    return m;
    // edgeKey is the change signal; nodes/edges are read imperatively above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, edgeKey]);

  /** True when this Output node contributes no channel at all, i.e. exactly
   *  graphToCode's red-fallback branch. Only then does the unwired Color row
   *  show RED — see OUTPUT_EMPTY_COLOR. Emission is exposure-gated, so a
   *  stored value on a hidden channel does not count. */
  const emitsNothing = useMemo(() => {
    if (wiredLabels.size > 0) return false;
    return !Object.keys(values).some(
      (k) => exposedSet.has(k) && storedValueEmits(k, values[k]),
    );
  }, [wiredLabels, values, exposedSet]);

  /**
   * Write one material's stored channel values.
   *
   * Material 0 writes the node's own `values` — where they have always lived,
   * so a single-material document is untouched by any of this; an added
   * material writes its own entry in `materials`. Both read the CURRENT node
   * imperatively rather than from the render closure, so two quick edits (a
   * scrub landing while a picker is open) cannot drop the first.
   */
  const writeMaterialValues = useCallback(
    (index: number, next: Record<string, string | number>) => {
      if (index === 0) {
        updateNodeData(id, { values: next } as Partial<OutputNodeData>);
        return;
      }
      const added = readAdded();
      const k = index - 1;
      if (!added[k]) return;
      added[k] = { ...added[k], values: next };
      setAddedMaterials(added);
    },
    [id, updateNodeData, readAdded, setAddedMaterials],
  );

  const readMaterialValues = useCallback(
    (index: number): Record<string, string | number> => {
      const node = useAppStore.getState().nodes.find((n) => n.id === id);
      if (!node) return {};
      if (index === 0) return ((node.data as OutputNodeData).values ?? {});
      const raw = (node.data as { materials?: OutputMaterial[] }).materials;
      return (Array.isArray(raw) ? raw[index - 1]?.values : undefined) ?? {};
    },
    [id],
  );

  /** Clear a channel's stored value — back to "default / none": the widget
   *  shows the channel default again and the channel stops emitting. */
  const clearChannelValue = useCallback(
    (index: number, channel: string) => {
      const current = readMaterialValues(index);
      if (!(channel in current)) return;
      const { [channel]: _dropped, ...rest } = current;
      writeMaterialValues(index, rest);
    },
    [readMaterialValues, writeMaterialValues],
  );

  const setChannelValue = useCallback(
    (index: number, channel: string, value: string | number) => {
      writeMaterialValues(index, { ...readMaterialValues(index), [channel]: value });
    },
    [readMaterialValues, writeMaterialValues],
  );

  // Tell React Flow to re-measure handles whenever the RENDERED port set
  // changes (settings toggle). Without this, dynamically mounted handles
  // (e.g. `emissive` after the user toggles it on) aren't in React Flow's
  // bounds map, so any edge connected to them silently fails to render until
  // the page is reloaded.
  //
  // The key folds EVERY material's exposed set, not just material 0's: adding
  // or removing a material mounts or unmounts a whole block of handles, and
  // React Flow never refreshes its bounds map on its own — an edge to a fresh
  // `m2:color` would stay in the store and still emit correct code while simply
  // never DRAWING, which a page reload then "fixes" (every handle is measured
  // on first mount) and so reads as a rendering glitch rather than a missing
  // effect.
  const updateNodeInternals = useUpdateNodeInternals();
  const exposedKey = materials
    .map((m, i) =>
      (i === 0 ? exposedPorts : materialExposedPorts(m, OUTPUT_DEFAULT_EXPOSED)).join('|'),
    )
    .join('\u0001');
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, exposedKey, updateNodeInternals]);

  // Only permanently exposed channels render (as rows) — no drag reveal here.
  const sectionPorts = (ids: string[], exposed: Set<string>) =>
    def.inputs.filter((p) => ids.includes(p.id) && exposed.has(p.id));

  /** The right-hand cell of a row: the incoming value when wired (read-only,
   *  plain text, blue when live — a fill means "editable", plain text means
   *  "derived"); otherwise the channel's stored-value widget, when it has
   *  one. Same editable-vs-derived contract as every ShaderNode row. */
  const rowWidget = (index: number, portId: string) => {
    const handle = channelHandle(index, portId);
    const wired = wiredLabels.get(handle);
    if (wired) {
      return (
        <LiveEdgeValue className="shader-node__edge-val output-node__val" {...wired} />
      );
    }
    const matValues = materials[index]?.values ?? {};
    if (portId in OUTPUT_COLOR_VALUE_PORTS) {
      const stored = matValues[portId];
      // On a material that emits nothing, the shader's real Color is the red
      // fallback — show that instead of a white the preview contradicts.
      const channelDefault =
        portId === 'color' && index === 0 && emitsNothing
          ? OUTPUT_EMPTY_COLOR
          : OUTPUT_COLOR_VALUE_PORTS[portId];
      return (
        <PaletteColorPicker
          className="output-node__val"
          // A stored channel colour IS the graph — it emits `color(0x…)` — so
          // this site is undoable and takes the bracket.
          history="bracket"
          value={typeof stored === 'string' ? stored : channelDefault}
          clearColor={channelDefault}
          onClear={() => clearChannelValue(index, portId)}
          onPick={(hex) => setChannelValue(index, portId, hex)}
        />
      );
    }
    if (portId in OUTPUT_FLOAT_VALUE_PORTS) {
      const stored = Number(matValues[portId]);
      const shown = Number.isFinite(stored) && matValues[portId] !== undefined && matValues[portId] !== null
        ? stored
        : OUTPUT_FLOAT_VALUE_PORTS[portId];
      return (
        <DragNumberInput
          compact
          className="output-node__val"
          value={shown}
          step={0.05}
          onChange={(v) =>
            setChannelValue(index, portId, CLAMP01_PORTS.has(portId) ? clamp01(v) : v)
          }
        />
      );
    }
    return null;
  };

  // Widget FIRST, label after — the ShaderNode row anatomy (socket, then the
  // value box beside it); the label trails like an out-label would.
  const renderRow = (index: number) => (port: (typeof def.inputs)[number]) => {
    const handle = channelHandle(index, port.id);
    return (
      <div key={handle} className="output-node__row">
        <TypedHandle
          type="target"
          position={Position.Left}
          id={handle}
          dataType={port.dataType}
          label={port.label}
        />
        {rowWidget(index, port.id)}
        <span className="output-node__port-label">{port.label}</span>
      </div>
    );
  };

  /**
   * One material: the mesh it shades, then its Pixel and Vertex sections.
   *
   * EVERY material carries the picker, material 0 included -- its row sits
   * directly under the node's header, each added material's directly under the
   * divider that opens it, so "which mesh does this block shade" is always the
   * first line of the block. Material 0's picker additionally offers "All
   * meshes (default)", which is what it does when it names nothing.
   */
  const renderMaterial = (index: number) => {
    const material = materials[index];
    const exposed = new Set(
      index === 0
        ? exposedPorts
        : materialExposedPorts(material, OUTPUT_DEFAULT_EXPOSED),
    );
    const pixel = sectionPorts(PIXEL_PORTS, exposed);
    const vertex = sectionPorts(VERTEX_PORTS, exposed);
    const targets = materialTargetNames(material);
    // An EARLIER material already names one of these meshes, so emission's
    // first-claim rule shadows this one for that mesh. Selecting a duplicate is
    // allowed on purpose (it is how two materials swap meshes), so the state is
    // legal -- but a section that looks live and contributes nothing is
    // precisely what nobody would think to report, hence the mark.
    const claimedAbove = new Set(
      materials.slice(0, index).flatMap((m) => materialTargetNames(m)),
    );
    const shadowed = targets.length > 0 && targets.every((n) => claimedAbove.has(n));

    // An ADDED material always shows its picker -- it always names a mesh, and
    // hiding the row would hide the fact plus the control to drop it. Material
    // 0's appears once there is something to choose between, and stays visible
    // if it already names one: reopening a graph without its model must not
    // strand a target the node no longer shows (it still emits).
    const showMeshRow = index > 0 || hasMeshes || targets.length > 0;

    return (
      // data-material-index is the right-click hit test: NodeEditor's
      // onNodeContextMenu walks `closest('[data-material-index]')` so the
      // settings menu opens ALREADY SCOPED to the section under the cursor.
      <div key={index} className="output-node__material" data-material-index={index}>
        {index > 0 && <div className="output-node__divider" />}

        {/* This SECTION's output socket — one per material, centred on its
            own block, so a multimesh Output visibly feeds the preview once
            per section (each gets its own PreviewLink wire, DOM order =
            material order). Deliberately a decorative <span>, NOT a React
            Flow Handle: the Output node has no outputs, and a real handle
            would invite a drag that can never land. Drawn permanently
            CONNECTED (solid fill, no hollow state) at twice the normal
            socket size, in the wire's own colour — the connection is a fact
            about the shader, not something the user wires up. */}
        <span className="output-node__preview-socket" aria-hidden="true" />

        {showMeshRow && (
          <div className="output-node__mesh-row">
            <MeshTargetPicker
              meshNames={meshNames}
              selected={targets}
              allowDefault={index === 0}
              shadowed={shadowed}
              onChange={(next) => setMaterialTargets(index, next)}
            />
            {index > 0 && (
              <button
                type="button"
                className="output-node__mesh-remove nodrag"
                title={t('Remove this mesh material', language)}
                aria-label={t('Remove this mesh material', language)}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => removeMaterial(index)}
              >
                {'\u00D7'}
              </button>
            )}
          </div>
        )}

        <div className="output-node__section">
          <div className="output-node__section-label">Pixel Shader</div>
          <div className="output-node__ports">{pixel.map(renderRow(index))}</div>
        </div>

        {vertex.length > 0 && (
          <>
            <div className="output-node__subdivider" />
            <div className="output-node__section">
              <div className="output-node__section-label">Vertex Shader</div>
              <div className="output-node__ports">{vertex.map(renderRow(index))}</div>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div
      className={`output-node ${selected ? 'output-node--selected' : ''}`}
      style={{ background: 'var(--node-bg)', border: '1.5px solid var(--cat-output)' }}
    >
      {/* Bare number, matching every ShaderNode badge — the unit is spelled out
          once on the CostBar meter rather than repeated on every node. */}
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>
          {cost}
        </span>
      )}

      {/* Main header — the node's name and nothing else. Which mesh each
          material shades is a per-material fact, so it belongs to the material
          block: material 0's picker is the first row UNDER this header, each
          added material's the first row under its divider — and so does the
          preview SOCKET, one per section (see renderMaterial). */}
      <div className="output-node__header" style={{ background: costColor }}>
        <span className="output-node__title" style={{ color: headerTextColor }}>Output</span>
      </div>

      {materials.map((_, index) => renderMaterial(index))}

      {/* Add another mesh material. Present only for a MODEL with a mesh left
          to claim: with none free the button could only mint a material that
          duplicates a claim, which emission drops and the sanitizer deletes —
          a control whose press does nothing reads as broken. */}
      {hasMeshes && materials.length <= MAX_ADDED_MATERIALS && canAddMaterial && (
        <div className="output-node__add-row">
          <button
            type="button"
            className="output-node__add nodrag"
            title={t('Shade another mesh with its own material', language)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={addMaterial}
          >
            {'\u002B'} {t('Add output', language)}
          </button>
        </div>
      )}
    </div>
  );
});
