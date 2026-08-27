import { useAppStore, resolveDeviceBudget } from '@/store/useAppStore';
import { t, portLabel } from '@/i18n';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { OUTPUT_DEFAULT_EXPOSED } from '../nodes/OutputNode';
import type { MaterialSettings, OutputNodeData } from '@/types';
import { removeEdgesForPort } from '@/utils/edgeUtils';
import { toggleExposedPort } from '@/utils/exposedPorts';
import { asOneHistoryEntry } from '@/utils/historyGesture';
import { useHistoryBracket } from '@/hooks/useHistoryBracket';
import { findDefaultOutput, meshTargetName } from '@/utils/outputTargets';
import { highlightMesh } from '@/utils/meshHighlight';
import { meshNameCounts } from '@/utils/meshInventory';

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

  // The Output the user right-clicked, not "the first one". With per-mesh
  // materials there are several, and editing one material's transparency from
  // a menu opened on another is exactly the kind of wrong that never announces
  // itself. Falls back to the default Output for the paths that open this menu
  // without a node id.
  const outputNode = (nodeId ? nodes.find((n) => n.id === nodeId) : null)
    ?? findDefaultOutput(nodes);
  const outputData = outputNode?.data as OutputNodeData | undefined;
  const settings: MaterialSettings = outputData?.materialSettings ?? {};

  // Sub-mesh targeting state. The inventory is session-only and arrives from
  // the sandboxed preview, so it is absent until a model has actually loaded.
  const inventory = useAppStore((s) => s.previewMeshInventory);
  const currentTarget = outputNode ? meshTargetName(outputNode) : null;
  const counts = meshNameCounts(inventory?.meshes ?? []);
  const inventoryHasTarget = !!currentTarget
    && !!inventory?.meshes.some((m) => m.name === currentTarget);
  // A mesh already claimed by ANOTHER Output cannot be claimed twice — one
  // mesh wears one material — so those rows are disabled rather than silently
  // losing to the first claimant at emission time.
  const claimedElsewhere = new Map<string, string>();
  for (const n of nodes) {
    if (n.id === outputNode?.id) continue;
    const name = meshTargetName(n);
    if (name) claimedElsewhere.set(name, n.id);
  }

  const exposedPorts = outputData?.exposedPorts ?? OUTPUT_DEFAULT_EXPOSED;
  const exposedSet = new Set(exposedPorts);

  const outputDef = NODE_REGISTRY.get('output');

  // NB no Uniforms list here. It duplicated a property's name/value editor
  // that already lives on the node itself (Node Settings) and in the preview's
  // Uniforms overlay — three places editing one value, and the only one that
  // showed float properties BUT NOT colour ones. The overlay is the live
  // surface (with "Set as default" to bake a tuning back into the graph); the
  // node is the authoring surface.

  const updateSettings = (patch: Partial<MaterialSettings>) => {
    if (!outputNode) return;
    const merged = { ...settings, ...patch };
    updateNodeData(outputNode.id, { materialSettings: merged } as Partial<OutputNodeData>);
  };

  /** Hiding a channel clears its stored widget value too — the documented
   *  rule for edges (a hidden socket must not keep live wires) extended to
   *  values: emission is exposure-gated, so a kept value would either emit
   *  invisibly or silently vanish from the code, depending on the gate. */
  const valuesWithout = (portId: string): Record<string, string | number> | undefined => {
    const values = outputData?.values;
    if (!values || !(portId in values)) return undefined;
    const { [portId]: _dropped, ...rest } = values;
    return rest;
  };

  /** Show or hide the opacity port based on transparent/alphaTest state. */
  const setOpacityPort = (show: boolean) => {
    if (!outputNode) return;
    const current = new Set(exposedPorts);
    const patch: Partial<OutputNodeData> = {};
    if (show) {
      current.add('opacity');
    } else {
      current.delete('opacity');
      removeEdgesForPort(outputNode.id, 'opacity');
      const rest = valuesWithout('opacity');
      if (rest) patch.values = rest;
    }
    patch.exposedPorts = Array.from(current);
    updateNodeData(outputNode.id, patch);
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
      const next = toggleExposedPort(outputNode.id, exposedPorts, portId);
      const patch: Partial<OutputNodeData> = { exposedPorts: next };
      if (!next.includes(portId)) {
        const rest = valuesWithout(portId);
        if (rest) patch.values = rest;
      }
      updateNodeData(outputNode.id, patch);
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

      {/* Which mesh this material shades. Only shown for a MODEL: the primitive
          geometries are a single unnamed mesh, so there is nothing to choose
          between and an empty picker would just raise a question the shader
          cannot answer. */}
      {inventory && inventory.meshes.length > 0 && (
        <div style={{ ...labelStyle, cursor: 'default' }}>
          <span>{t('Target mesh', language)}</span>
          <select
            value={currentTarget ?? ''}
            onChange={(e) => {
              const name = e.target.value;
              // One updateNodeData, so picking a target is one undo entry.
              updateNodeData(outputNode!.id, name
                ? { meshTarget: { name } }
                : { meshTarget: undefined });
              // Flash the chosen mesh in the 3D view. Deliberately on CHANGE
              // rather than on hovering each option: a native select popup is
              // drawn by the OS, so `<option>` mouse events are unreliable
              // across browsers and absent entirely on touch — a highlight
              // that only some users ever see is worse than one that always
              // fires at the moment of choosing.
              highlightMesh(name || null);
              if (name) window.setTimeout(() => highlightMesh(null), 1200);
            }}
            style={selectStyle}
          >
            <option value="">{t('All meshes (default)', language)}</option>
            {inventory.meshes.map((m) => {
              const shared = counts.get(m.name) ?? 1;
              const takenBy = claimedElsewhere.get(m.name);
              return (
                <option
                  key={`${m.index}:${m.name}`}
                  value={m.name}
                  disabled={takenBy !== undefined}
                >
                  {m.name}
                  {shared > 1 ? ` (x${shared})` : ''}
                  {m.materialName ? ` — ${m.materialName}` : ''}
                  {takenBy !== undefined ? ` — ${t('already targeted', language)}` : ''}
                </option>
              );
            })}
          </select>
        </div>
      )}

      {/* A target whose mesh is not in the loaded model — the NORMAL case, not
          an edge case: the graph persists and the model does not, so this is
          what every reload without the model looks like. Named rather than
          silently cleared, so re-dropping the model restores the binding. */}
      {currentTarget && !inventoryHasTarget && (
        <div style={{ ...labelStyle, cursor: 'default', color: 'var(--text-secondary)' }}>
          <span>
            {'\u26A0 '}
            {t('Not in the loaded model', language)}: {currentTarget}
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
