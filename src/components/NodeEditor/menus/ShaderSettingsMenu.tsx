import { useEffect, useRef, useState } from 'react';
import { useAppStore, resolveDeviceBudget } from '@/store/useAppStore';
import { t, portLabel } from '@/i18n';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { OUTPUT_DEFAULT_EXPOSED } from '../nodes/OutputNode';
import type { MaterialSettings, OutputNodeData } from '@/types';
import { removeEdgesForPort } from '@/utils/edgeUtils';
import { toggleExposedPort } from '@/utils/exposedPorts';
import { asOneHistoryEntry } from '@/utils/historyGesture';
import { useHistoryBracket } from '@/hooks/useHistoryBracket';
import {
  findDefaultOutput,
  outputMaterials,
  materialExposedPorts,
  materialTargetNames,
  channelHandle,
  type OutputMaterial,
} from '@/utils/outputMaterials';

/** Ports that can be toggled on/off in the output node settings, listed in
 *  the SAME order as the node's socket arrangement (the registry def's
 *  inputs). Color is excluded (always exposed) and Opacity is excluded —
 *  it's auto-managed by transparent/alphaTest. */
const OPTIONAL_OUTPUT_PORTS = ['emissive', 'roughness', 'metalness', 'discard', 'normal', 'env'];

export function ShaderSettingsMenu({ nodeId }: { nodeId?: string }) {
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const language = useAppStore((s) => s.language);
  const totalCost = useAppStore((s) => s.totalCost);
  const selectedHeadsetId = useAppStore((s) => s.selectedHeadsetId);
  const costProfiles = useAppStore((s) => s.costProfiles);
  const nodes = useAppStore((s) => s.nodes);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  // The Alpha Clip threshold is a range input: React's onChange on a range is
  // the native `input` event, so it fires per pointermove FRAME and each frame
  // reaches updateNodeData -> an unconditional pushHistory. Bracket the drag
  // so it lands as one undo entry (ColorNode.tsx:135-154 pattern).
  const { bracket, closeBracket } = useHistoryBracket();
  const device = resolveDeviceBudget(selectedHeadsetId, costProfiles);

  // The Output the user right-clicked, falling back to THE Output for the
  // paths that open this menu without a node id (the canvas background).
  const outputNode = (nodeId ? nodes.find((n) => n.id === nodeId) : null)
    ?? findDefaultOutput(nodes);
  const outputData = outputNode?.data as OutputNodeData | undefined;

  // WHICH MATERIAL this menu edits. Per-mesh materials are sections of the one
  // Output node, and each carries its own channels and its own material
  // settings — SCOPED by the section the user right-clicked; the menu shows a
  // static scope line and deliberately carries no selector of its own (see the
  // scope row below). Material 0 is the default (the whole-model material);
  // the rest are named by their mesh.
  //
  // The MESH each material shades is deliberately NOT editable here: that
  // picker lives on the node itself, where the sections are, and two controls
  // for one binding is how they end up disagreeing.
  const materials = outputNode ? outputMaterials(outputNode) : [];
  // Seeded from the SECTION the user right-clicked (`data-material-index` on
  // the node's material blocks → contextMenu.materialIndex), so each section
  // opens its own scoped menu and channels can be exposed per material without
  // hunting through the selector. The effect matters for the second click: a
  // right-click on ANOTHER section while this menu is open moves the menu
  // rather than remounting it, so the initializer alone would keep the old
  // section — and it keys on the contextMenu OBJECT (a fresh identity per
  // openContextMenu call), never the index VALUE: re-right-clicking the SAME
  // section after manually switching the selector writes the same number, and
  // a value-keyed effect would never fire, leaving the menu scoped to the
  // manual choice on exactly the gesture that re-asserts the section.
  const menuState = useAppStore((s) => s.contextMenu);
  const seededIndex = menuState.materialIndex;
  const [materialIndex, setMaterialIndex] = useState(seededIndex ?? 0);
  useEffect(() => {
    if (typeof seededIndex === 'number') setMaterialIndex(seededIndex);
  }, [menuState, seededIndex]);
  // Materials are ANONYMOUS (indices, no ids), so adding or removing one on
  // the node while this menu is open shifts every later index under the
  // selection — the menu would silently edit the NEIGHBOUR of the section it
  // was opened on. A visible reset to the default material is the honest
  // option; the next right-click re-scopes.
  const materialCount = materials.length;
  const countRef = useRef(materialCount);
  useEffect(() => {
    if (countRef.current !== materialCount) {
      countRef.current = materialCount;
      setMaterialIndex(0);
    }
  }, [materialCount]);
  const activeIndex = materialIndex < materials.length ? materialIndex : 0;
  const activeMaterial: OutputMaterial | undefined = materials[activeIndex];

  const settings: MaterialSettings = (activeIndex === 0
    ? outputData?.materialSettings
    : activeMaterial?.materialSettings) ?? {};
  const exposedPorts = activeIndex === 0
    ? (outputData?.exposedPorts ?? OUTPUT_DEFAULT_EXPOSED)
    : materialExposedPorts(activeMaterial, OUTPUT_DEFAULT_EXPOSED);
  const exposedSet = new Set(exposedPorts);

  /** Patch the ACTIVE material — the node's own fields for material 0, its
   *  `materials` entry otherwise. One writer, so the two shapes cannot drift. */
  const patchMaterial = (patch: Partial<OutputMaterial>) => {
    if (!outputNode) return;
    if (activeIndex === 0) {
      updateNodeData(outputNode.id, patch as Partial<OutputNodeData>);
      return;
    }
    const added = materials.slice(1).map((m, i) =>
      i === activeIndex - 1 ? { ...m, ...patch } : m,
    );
    updateNodeData(outputNode.id, { materials: added } as Partial<OutputNodeData>);
  };

  const outputDef = NODE_REGISTRY.get('output');

  // NB no Uniforms list here. It duplicated a property's name/value editor
  // that already lives on the node itself (Node Settings) and in the preview's
  // Uniforms overlay — three places editing one value, and the only one that
  // showed float properties BUT NOT colour ones. The overlay is the live
  // surface (with "Set as default" to bake a tuning back into the graph); the
  // node is the authoring surface.

  const updateSettings = (patch: Partial<MaterialSettings>) => {
    patchMaterial({ materialSettings: { ...settings, ...patch } });
  };

  /** Hiding a channel clears its stored widget value too — the documented
   *  rule for edges (a hidden socket must not keep live wires) extended to
   *  values: emission is exposure-gated, so a kept value would either emit
   *  invisibly or silently vanish from the code, depending on the gate. */
  const valuesWithout = (portId: string): Record<string, string | number> | undefined => {
    const values = activeIndex === 0 ? outputData?.values : activeMaterial?.values;
    if (!values || !(portId in values)) return undefined;
    const { [portId]: _dropped, ...rest } = values;
    return rest;
  };

  /** Show or hide the opacity port based on transparent/alphaTest state. */
  const setOpacityPort = (show: boolean) => {
    if (!outputNode) return;
    const current = new Set(exposedPorts);
    const patch: Partial<OutputMaterial> = {};
    if (show) {
      current.add('opacity');
    } else {
      current.delete('opacity');
      // The handle this material's opacity is wired through — bare for the
      // default, namespaced for an added material.
      removeEdgesForPort(outputNode.id, channelHandle(activeIndex, 'opacity'));
      const rest = valuesWithout('opacity');
      if (rest) patch.values = rest;
    }
    patch.exposedPorts = Array.from(current);
    patchMaterial(patch);
  };

  // updateSettings + setOpacityPort are two updateNodeData calls, and hiding a
  // WIRED opacity adds removeEdgesForPort's own push — three history entries
  // for one checkbox, where the first Cmd+Z leaves transparent already false
  // and the wire already deleted (nothing visibly undone). One bracket.
  const handleTransparentChange = (checked: boolean) => asOneHistoryEntry(() => {
    if (checked) {
      updateSettings({ transparent: true });
      setOpacityPort(true);
    } else {
      // Clear depthWrite too. Its checkbox is rendered ONLY while transparent
      // is on, so a `false` set here and then abandoned was unreachable — and
      // it kept shipping (the emitter has no transparent guard), leaving an
      // OPAQUE mesh drawing with depth writes off. On a teapot/bunny, a
      // Double-sided material or a displaced sphere that self-occludes into
      // holes which look exactly like an alpha cutout, with nothing wired to
      // Opacity or Discard and no visible control to undo it.
      updateSettings({ transparent: false, depthWrite: undefined });
      if (!settings.alphaTest) setOpacityPort(false);
    }
  });

  const handleAlphaClipChange = (checked: boolean) => asOneHistoryEntry(() => {
    if (checked) {
      updateSettings({ alphaTest: 0.5 });
      setOpacityPort(true);
    } else {
      updateSettings({ alphaTest: 0 });
      if (!settings.transparent) setOpacityPort(false);
    }
  });

  const handleTogglePort = (portId: string) => {
    // The guard stays OUTSIDE the bracket: beginInteraction pushes a snapshot
    // AND clears `future`, so wrapping an early-returning body would cost an
    // undo entry and destroy the redo stack for a click that did nothing.
    if (!outputNode) return;
    // toggleExposedPort's edge drop pushes history and is evaluated BEFORE the
    // updateNodeData below, which pushes again. Bracketed, hiding a wired
    // channel is one undoable act.
    asOneHistoryEntry(() => {
      const next = toggleExposedPort(
        outputNode.id,
        exposedPorts,
        portId,
        channelHandle(activeIndex, portId),
      );
      const patch: Partial<OutputMaterial> = { exposedPorts: next };
      if (!next.includes(portId)) {
        const rest = valuesWithout(portId);
        if (rest) patch.values = rest;
      }
      patchMaterial(patch);
    });
  };

  const checkboxStyle: React.CSSProperties = {
    width: 14,
    height: 14,
    cursor: 'pointer',
    accentColor: 'var(--border-focus)',
  };

  const labelStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    padding: '4px var(--space-3)',
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  };

  const selectStyle: React.CSSProperties = {
    padding: '2px 4px',
    fontSize: 'var(--font-size-sm)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--border-radius-sm)',
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  };

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">{t('Shader Settings', language)}</div>
      <div
        style={{
          padding: 'var(--space-2) var(--space-3)',
          fontSize: 'var(--font-size-sm)',
          color: 'var(--text-secondary)',
        }}
      >
        <div>{t('Total Cost:', language)} <strong style={{ color: 'var(--text-primary)' }}>{totalCost}</strong> {t('pts', language)}</div>
        <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
          {t('Budget:', language)} {device.maxPoints} {t('pts max', language)} ({device.label})
        </div>
      </div>

      {/* Output port visibility toggles */}
      {outputDef && (
        <>
          <div className="context-menu__divider" />
          <div className="context-menu__category">{t('Output Ports', language)}</div>
          {OPTIONAL_OUTPUT_PORTS.map((portId) => {
            const port = outputDef.inputs.find((p) => p.id === portId);
            if (!port) return null;
            return (
              <label
                key={portId}
                style={labelStyle}
                title={port.description ? t(port.description, language) : undefined}
              >
                <input
                  type="checkbox"
                  checked={exposedSet.has(portId)}
                  onChange={() => handleTogglePort(portId)}
                  style={checkboxStyle}
                />
                {portLabel(port.label, language)}
              </label>
            );
          })}
        </>
      )}

      {/* Displacement mode — only relevant when position port is exposed */}
      {exposedSet.has('position') && (
        <>
          <div className="context-menu__divider" />
          <div className="context-menu__category">{t('Displacement', language)}</div>
          <label style={labelStyle}>
            <input
              type="checkbox"
              checked={(settings.displacementMode ?? 'normal') === 'normal'}
              onChange={(e) =>
                updateSettings({ displacementMode: e.target.checked ? 'normal' : 'offset' })
              }
              style={checkboxStyle}
            />
            {t('Along Normal', language)}
          </label>
          <label
            style={labelStyle}
            title={t("Weld shared vertices so the surface deforms as one skin. Off: a cube's faces split apart (each face displaces on its own).", language)}
          >
            <input
              type="checkbox"
              checked={settings.mergeVertices !== false}
              onChange={(e) => updateSettings({ mergeVertices: e.target.checked })}
              style={checkboxStyle}
            />
            {t('Merge Vertices', language)}
          </label>
        </>
      )}

      <div className="context-menu__divider" />
      <div className="context-menu__category">{t('Material', language)}</div>

      {/* WHICH material these settings belong to — a static scope LINE, not a
          selector: right-clicking a SECTION on the node is the ONE scoping
          control (data-material-index → contextMenu.materialIndex), and a
          dropdown here was a second control for the same scope — the exact
          argument that keeps the MESH picker off this menu. Named by MESH
          (the first one plus an ellipsis, the node picker's own rule), since
          that is how the user thinks of them — "the glass one" — and the
          node's sections are labelled the same way. Shown only when there is
          more than one, when "which one am I editing" is a real question;
          `#i` is the last resort for a material whose target the loaded model
          no longer has. */}
      {materials.length > 1 && (
        <div style={{ ...labelStyle, cursor: 'default' }}>
          <span>{t('Material', language)}</span>
          <span style={{ fontWeight: 700 }}>
            {activeMaterial && materialTargetNames(activeMaterial)[0]
              ? `${materialTargetNames(activeMaterial)[0]}${materialTargetNames(activeMaterial).length > 1 ? ' \u2026' : ''}`
              : (activeIndex === 0 ? t('All meshes (default)', language) : `#${activeIndex}`)}
          </span>
        </div>
      )}

      <label style={labelStyle}>
        <input
          type="checkbox"
          checked={!!settings.transparent}
          onChange={(e) => handleTransparentChange(e.target.checked)}
          style={checkboxStyle}
        />
        {t('Transparent', language)}
      </label>

      <label style={labelStyle}>
        <input
          type="checkbox"
          checked={!!settings.alphaTest}
          onChange={(e) => handleAlphaClipChange(e.target.checked)}
          style={checkboxStyle}
        />
        {t('Alpha Clip', language)}
      </label>

      {!!settings.alphaTest && (
        <div style={{ padding: '2px var(--space-3)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <input
            type="range"
            min={0.01}
            // Not 1: three discards on `alpha <= alphaTest`, so a threshold of
            // exactly 1 erases an untouched (alpha = 1) surface entirely.
            max={0.99}
            step={0.01}
            value={settings.alphaTest}
            onChange={(e) => { bracket(); updateSettings({ alphaTest: parseFloat(e.target.value) }); }}
            onPointerUp={closeBracket}
            onPointerCancel={closeBracket}
            onKeyUp={closeBracket}
            onBlur={closeBracket}
            style={{ flex: 1, cursor: 'pointer', accentColor: 'var(--border-focus)' }}
          />
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', minWidth: 28, textAlign: 'right' }}>
            {settings.alphaTest.toFixed(2)}
          </span>
        </div>
      )}

      <div style={{ ...labelStyle, cursor: 'default' }}>
        <span>{t('Side', language)}</span>
        <select
          value={settings.side ?? 'front'}
          onChange={(e) => updateSettings({ side: e.target.value as MaterialSettings['side'] })}
          style={selectStyle}
        >
          <option value="front">{t('Front', language)}</option>
          <option value="back">{t('Back', language)}</option>
          <option value="double">{t('Double', language)}</option>
        </select>
      </div>

      {settings.transparent && (
        <label style={labelStyle}>
          <input
            type="checkbox"
            checked={settings.depthWrite !== false}
            onChange={(e) => updateSettings({ depthWrite: e.target.checked })}
            style={checkboxStyle}
          />
          {t('Depth Write', language)}
        </label>
      )}

      <div className="context-menu__divider" />
      <button className="context-menu__item" onClick={closeContextMenu}>
        {t('Close', language)}
      </button>
    </div>
  );
}
