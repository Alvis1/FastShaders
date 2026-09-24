import { useAppStore } from '@/store/useAppStore';
import { t, portLabel } from '@/i18n';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { OUTPUT_DEFAULT_EXPOSED } from '../nodes/OutputNode';
import type { MaterialSettings, OutputNodeData, AppNode, AppEdge } from '@/types';
import { outputNodeValues } from '@/types';
import { removeEdgesForPort, unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { toggleExposedPort } from '@/utils/exposedPorts';
import { asOneHistoryEntry } from '@/utils/historyGesture';
import { useHistoryBracket } from '@/hooks/useHistoryBracket';
import {
  findDefaultOutput,
  outputMaterials,
  outputNodes,
  moduleSettingsOutput,
  channelHandle,
  sectionLabel,
  readModelSignature,
  type OutputMaterial,
} from '@/utils/outputMaterials';
import { formatSectionLabel } from '../nodes/sectionLabelText';
import { isEvalMode } from '@/eval/evalMode';
import { graphTextureMemory, textureMemoryLine, TEXTURE_MEMORY_HINT_KEY } from '@/utils/textureMemory';

/** Ports that can be toggled on/off in the output node settings, listed in
 *  the SAME order as the node's socket arrangement (the registry def's
 *  inputs). Color is excluded (always exposed) and Opacity is excluded —
 *  it's auto-managed by transparent/alphaTest. */
const OPTIONAL_OUTPUT_PORTS = ['emissive', 'roughness', 'metalness', 'discard', 'normal', 'env'];

/** One-entry memo on the RAW store arrays. The selector below runs on every
 *  store notification (hover writes included), but the figure can only change
 *  when the graph does; unwrapping inside the selector would mint a new edge
 *  array each time and defeat an identity memo. */
let textureMemoryMemo: { nodes: AppNode[]; edges: AppEdge[]; key: string } | null = null;
function textureMemoryKey(nodes: AppNode[], edges: AppEdge[]): string {
  if (textureMemoryMemo && textureMemoryMemo.nodes === nodes && textureMemoryMemo.edges === edges) return textureMemoryMemo.key;
  const m = graphTextureMemory(nodes, unwrapCollapsedGroupEdges(nodes, edges));
  const key = `${m.bytes}|${m.count}`;
  textureMemoryMemo = { nodes, edges, key };
  return key;
}

export function ShaderSettingsMenu({ nodeId }: { nodeId?: string }) {
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const language = useAppStore((s) => s.language);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  // The Alpha Clip threshold is a range input: React's onChange on a range is
  // the native `input` event, so it fires per pointermove FRAME and each frame
  // reaches updateNodeData -> an unconditional pushHistory. Bracket the drag
  // so it lands as one undo entry (ColorNode.tsx:135-154 pattern).
  const { bracket, closeBracket } = useHistoryBracket();
  // The texture-memory line is hidden in every study arm (a new
  // participant-visible element; if it is ever shown there it must also honour
  // `evalTask().pointsVisible`, since it is cost feedback).
  const showTextureMemory = !isEvalMode();
  const texMemKey = useAppStore((s) => (showTextureMemory ? textureMemoryKey(s.nodes, s.edges) : '0|0'));
  const [texBytes, texCount] = texMemKey.split('|').map(Number);

  // The Output the user right-clicked, falling back to THE Output for the
  // paths that open this menu without a node id (the canvas background).
  //
  // Resolved INSIDE the selector so this menu subscribes to the one node it
  // draws rather than to the whole array: both branches return an object out
  // of `s.nodes`, which React Flow's `applyNodeChanges` reuses when it did not
  // touch that node, so `Object.is` bails on every notification about some
  // other node — an open menu was otherwise re-rendering its ~15 rows on every
  // frame of an unrelated drag.
  const outputNode = useAppStore((s) => (nodeId ? s.nodes.find((n) => n.id === nodeId) : null)
    ?? findDefaultOutput(s.nodes));
  const outputData = outputNode?.data as OutputNodeData | undefined;

  // ONE Output node is ONE material, so this menu has nothing to scope: the
  // node the user right-clicked IS the material, and its channels, its stored
  // values and its material settings are the node's own fields. The section
  // selector, its `contextMenu.materialIndex` seed and the count-change reset
  // all went with the stack they navigated.
  //
  // The MESH this material shades is deliberately NOT editable here: that
  // picker lives on the node itself, and two controls for one binding is how
  // they end up disagreeing.
  const materials = outputNode ? outputMaterials(outputNode) : [];
  /** How many Output nodes exist — "which one am I editing" is a real question
   *  only when there is more than one (and this menu can also be opened from
   *  the canvas, with no node under the cursor at all). A number selector, so
   *  it re-renders on a count change and on nothing else. */
  const outputCount = useAppStore((s) => outputNodes(s.nodes).length);
  /** Does THIS node own the module's two geometry directives? `mergeVertices`
   *  and `displacementMode` are written at module level from
   *  `moduleSettingsOutput`, never per part, so on any other node their
   *  checkboxes wrote a field nothing read. A boolean selector, so a graph
   *  notify that does not move the election re-renders nothing. */
  const ownsModuleSettings = useAppStore(
    (s) => !!outputNode && moduleSettingsOutput(s.nodes)?.id === outputNode.id,
  );

  const settings: MaterialSettings = outputData?.materialSettings ?? {};
  const exposedPorts = outputData?.exposedPorts ?? OUTPUT_DEFAULT_EXPOSED;
  const exposedSet = new Set(exposedPorts);

  /** Patch this node's material — its own fields, the only material it has. */
  const patchMaterial = (patch: Partial<OutputMaterial>) => {
    if (!outputNode) return;
    updateNodeData(outputNode.id, patch as Partial<OutputNodeData>);
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
    // Through `outputNodeValues`, never the raw field: `outputData` is a cast of
    // node data, NO restore path coerces an Output's node-level `values` (the
    // sanitizer cleans MATERIALS entries only), and `'opacity' in 5` THROWS —
    // in a React event handler, so a tampered `.fastshader` made this checkbox
    // silently do nothing. See that accessor's doc.
    const values = outputNodeValues(outputData);
    if (values[portId] === undefined) return undefined;
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
      // One node, one material: every channel is wired through its BARE handle
      // (`channelHandle(0, …)`), which is what every saved edge already spells.
      removeEdgesForPort(outputNode.id, channelHandle(0, 'opacity'));
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
        channelHandle(0, portId),
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
      {/* This menu is scoped to ONE Output NODE, which since the per-material
          split IS one material — its channels, its stored values, its exposed
          ports and its four emitted material settings are all that node's own
          fields. It is laid out by SHADER STAGE below — the pixel/fragment
          side (which channels it writes, and the render state it writes them
          with) and the vertex side (displacement) — because that is the
          question a user arrives with. The texture figure is the one
          whole-DOCUMENT row left, and it says "document" in its own words. */}
      <div className="context-menu__category">{t('Material Settings', language)}</div>
      <div className="context-menu__divider" />
      {/* Texture MEMORY, the currency points do not price: a figure, not a
          verdict, and the ONLY surface that carries it. Total Cost and the
          device budget used to sit above it under a "Shader (whole document)"
          heading; they are the CostBar's own two figures, shown at the top of
          the app at all times, so here they were a third copy of a number the
          user was already looking at. A plain `title`, so the app-wide
          TooltipLayer raises it. */}
      {showTextureMemory && texCount > 0 && (
        <div
          title={t(TEXTURE_MEMORY_HINT_KEY, language)}
          style={{
            padding: 'var(--space-1) var(--space-3) var(--space-2)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--text-muted)',
          }}
        >
          {textureMemoryLine(texBytes, texCount, language)}
        </div>
      )}

      {/* THE PIXEL STAGE: which channels this material writes, and the render
          state it writes them with. The two were "Output Ports" and
          "Rendering" — one list of sockets and one list of material flags,
          both describing the fragment shader, separated by a heading that
          made them read as unrelated. `position` is deliberately NOT in
          OPTIONAL_OUTPUT_PORTS, so nothing vertex-stage is listed here. */}
      <div className="context-menu__divider" />
      <div className="context-menu__category">{t('Pixel (Fragment) Shader', language)}</div>
      {outputDef && (
        <>
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

      {/* WHICH material these settings belong to — a static scope LINE, not a
          selector: the NODE is the scope now (one node, one material), and a
          dropdown here would be a second control for a binding the node's own
          picker already owns — the exact argument that keeps the MESH picker
          off this menu. Named by MESH (the first one plus an ellipsis, the
          node picker's own rule), since that is how the user thinks of them —
          "the glass one". Shown only while SEVERAL Output nodes exist, when
          "which one am I editing" is a real question — this menu also opens
          from the canvas with no node under the cursor, and then the line is
          the only thing that says which Output answered. ONE label derivation
          for the menu and the node: `sectionLabel` decides what the label is,
          `formatSectionLabel` words it, so an untargeted Output reads
          "All meshes (default)" here exactly as it does on the node. */}
      {outputCount > 1 && (
        <div style={{ ...labelStyle, cursor: 'default' }}>
          <span>{t('Material', language)}</span>
          <span style={{ fontWeight: 700 }}>
            {formatSectionLabel(sectionLabel(materials, 0, readModelSignature(outputData)), language)}
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

      {/* Blender's Shade Smooth / Shade Flat. A SELECT and not a checkbox
          because both states have names the user is looking for — "Flat
          Shading" unticked does not say "smooth" — and because it sits beside
          Side, which is the same shape. `flatShading` is a THREE.Material
          property three's node materials honour, so it is per-material like
          the rows around it: `undefined` is smooth, and only the flat case is
          stored, which is what keeps every existing graph byte-identical. */}
      <div style={{ ...labelStyle, cursor: 'default' }}>
        <span>{t('Shading', language)}</span>
        <select
          value={settings.flatShading ? 'flat' : 'smooth'}
          onChange={(e) => updateSettings({ flatShading: e.target.value === 'flat' ? true : undefined })}
          style={selectStyle}
        >
          <option value="smooth">{t('Smooth', language)}</option>
          <option value="flat">{t('Flat', language)}</option>
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

      {/* THE VERTEX STAGE ("Displacement" until the stage rename) — only
          relevant when position port is exposed, and
          only on the Output that OWNS these two keys. Neither is a per-material
          setting: `mergeVertices` is a module-level geometry directive the
          loader reads off the return object, and `displacementMode` has no
          loader key at all — `buildShaderModule` takes both from
          `moduleSettingsOutput`, so on any OTHER node these checkboxes wrote a
          field nothing read and the geometry went on following the default's.
          A pre-existing gap CLAUDE.md admits; showing them where they apply is
          what makes the "Material Settings" title above honest. */}
      {exposedSet.has('position') && ownsModuleSettings && (
        <>
          <div className="context-menu__divider" />
          <div className="context-menu__category">{t('Vertex Shader', language)}</div>
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
      <button className="context-menu__item" onClick={closeContextMenu}>
        {t('Close', language)}
      </button>
    </div>
  );
}
