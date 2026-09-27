import { useAppStore } from '@/store/useAppStore';
import { valueNum } from '@/utils/valueCoerce';
import { t, portLabel } from '@/i18n';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getNodeValues } from '@/types';
import type { AppNode, ShaderNodeData } from '@/types';
import { effectiveExposedPorts, toggleExposedPort } from '@/utils/exposedPorts';
import { asOneHistoryEntry } from '@/utils/historyGesture';
import { removeEdgesForPort } from '@/utils/edgeUtils';
import { isSplatLit, isSplatLightColorPort, splatLitValues, SPLAT_LIGHT_PORTS } from '@/utils/splatLight';
import { isSplatReplaceColor, splatReplaceColorValues } from '@/utils/splatColor';
import { hasTrueFlag, withTrueFlag } from '@/utils/trueFlag';
import { splatCountLine, SPLAT_COUNT_HINT_KEY } from '@/utils/splatCount';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import { NumberRow, NodeActions } from './menuShared';
import {
  SPLAT_NODE_CONFIG,
  SPLAT_OWN_COLOUR_KEY,
  SPLAT_CLEAR_SWATCH,
  splatStoredColor,
  splatClearable,
  SplatLightColorPicker,
} from '../nodes/SplatOutputNode';

/** The one splat setting that is not a socket: keep the OUTSIDE of the cut
 *  instead of the inside. Rendered in the Cut section, after Feather. */
export const SPLAT_INVERT_KEY = 'Invert cut';
export const SPLAT_INVERT_HINT_KEY =
  'Remove the splats where Cut is below zero instead of above it — a distance field wired to Cut then keeps its outside.';

/** The Shade section's switch: Color REPLACES the captured colour instead of
 *  tinting it (utils/splatColor.ts). Off — the default — Color multiplies. */
export const SPLAT_REPLACE_COLOR_KEY = 'Replace own colour';
export const SPLAT_REPLACE_COLOR_HINT_KEY =
  'Color replaces the colour each splat was captured with — tick it when Color is built from Vertex Color, or that colour counts twice. Left unticked, Color multiplies it like a coloured gel: white keeps a splat as it was, black darkens it.';

/** The Light section's switch: the loader's surface normal plus the key
 *  light the section's rows set (utils/splatLight.ts). */
export const SPLAT_LIT_KEY = 'React to light';
export const SPLAT_LIT_HINT_KEY =
  'Light each splat with the key light below, using its flattest axis as its surface normal — the way Blender relights splats. The captured colour already holds the light of the capture, so the side away from the light darkens.';

/**
 * `values` with Invert switched: `invert: true` added, or the key DELETED —
 * never `false`, so a node switched back off is byte-for-byte the node that
 * was never touched (the flag rule, utils/trueFlag.ts; emission counts only
 * the literal `true`). A fresh object; the input is never mutated.
 */
export function splatInvertValues(values: Readonly<Record<string, unknown>>, on: boolean): Record<string, unknown> {
  return withTrueFlag(values, 'invert', on);
}

/**
 * Switch a Splat Output's light (utils/splatLight.ts). ON writes `lit: true`
 * — ONE updateNodeData, so one undo entry. OFF deletes the key, hides the five
 * Light sockets and drops their wires, as unticking each would, so no wire is
 * left into a light that no longer exists — ONE bracket, one undo entry — and
 * KEEPS their stored values, so switching back on restores the same light (a
 * code-panel Apply carries them across the resync too: carrySplatLightValues,
 * utils/splatLight.ts; and Reset Values keeps `lit` itself). The exposed
 * list is written only when it really listed a Light socket: a node on the
 * implicit default keeps no list, so switching the light on and off again
 * leaves the node that was never touched. A call that would change nothing
 * returns before any write (a bracket clears the redo stack even when its
 * body writes nothing).
 */
export function setSplatLit(nodeId: string, on: boolean): void {
  const { nodes, updateNodeData } = useAppStore.getState();
  const node = nodes.find((n) => n.id === nodeId);
  if (!node || isSplatLit((node.data as { values?: unknown }).values) === on) return;
  const values = getNodeValues(node);
  if (on) {
    updateNodeData(nodeId, { values: splatLitValues(values, true) } as unknown as Partial<ShaderNodeData>);
    return;
  }
  const exposed = effectiveExposedPorts(node);
  const patch: { values: Record<string, unknown>; exposedPorts?: string[] } = { values: splatLitValues(values, false) };
  if (exposed.some((p) => SPLAT_LIGHT_PORTS.includes(p))) {
    patch.exposedPorts = exposed.filter((p) => !SPLAT_LIGHT_PORTS.includes(p));
  }
  asOneHistoryEntry(() => {
    for (const port of SPLAT_LIGHT_PORTS) removeEdgesForPort(nodeId, port);
    updateNodeData(nodeId, patch as unknown as Partial<ShaderNodeData>);
  });
}

/**
 * The Splat Output's settings menu — RaymarchSettingsMenu's shape: every
 * socket the node has, grouped as the node groups them, each row a checkbox
 * that shows or hides the SOCKET on the node plus the socket's value editor
 * (the Color swatch, a number with the node's own step and clamp). Cut and
 * Move store nothing, so their rows are the checkbox alone. Hiding a socket
 * drops its wires (`toggleExposedPort`) but KEEPS its stored value — a Feather
 * or Size set here applies whether or not its socket is on the node.
 *
 * Four things the march menu does not have:
 *
 *   • REPLACE OWN COLOUR, after the Shade rows: `values.replaceColor = true` or
 *     the key deleted (the Invert rule), ONE `updateNodeData`. Unticked — the
 *     default — a wired or picked Color TINTS each splat's captured colour.
 *   • INVERT CUT, a checkbox writing `values.invert = true` or deleting the key
 *     — never `false`, so an untouched node and a node switched back off are
 *     the same document (the absent-key rule; emission counts only the literal
 *     `true`). ONE `updateNodeData`, so ONE undo entry.
 *   • REACT TO LIGHT, heading the Light section: `values.lit = true` or the
 *     key deleted (the Invert rule). The five Light rows are listed only
 *     while it is on — they do nothing otherwise. Switching it OFF also hides
 *     those sockets on the node and drops their wires, as unticking each one
 *     would, so no wire is left into a light that no longer exists; their
 *     stored values are KEPT, so switching back on restores the same light —
 *     across a code-panel Apply as well (`carrySplatLightValues`). A Light row
 *     is also listed while a wire reaches it, lit or not, so any such wire can
 *     be unticked here.
 *     One bracket, one undo entry.
 *   • THE SPLAT COUNT the preview reported for the loaded scene
 *     (`previewSplatFacts`, session-only), in the Material Settings menu's
 *     texture-memory style. Absent while no splat is loaded, and while one is
 *     loaded but PARKED (the Model menu shows a primitive): the cost bar's own
 *     `previewShowsModel` gate, since a parked splat draws nothing and the
 *     line's hint speaks of a per-splat cost being paid now.
 */
export function SplatSettingsMenu({ nodeId }: { nodeId: string }) {
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const language = useAppStore((s) => s.language);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  // Only while the preview SHOWS the model — the cost bar's selector, verbatim.
  const splatFacts = useAppStore((s) => (s.previewShowsModel ? s.previewSplatFacts : null));
  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId)) as AppNode | undefined;
  // The node's own wires (the menu is mounted only while open): a Light row is
  // listed whenever its socket is wired, lit or not, so a wire that reached an
  // unlit node (a file can carry one) can always be unticked here.
  const edges = useAppStore((s) => s.edges);
  const def = NODE_REGISTRY.get('splatOutput');
  if (!node || !def) return null;

  const config = SPLAT_NODE_CONFIG;
  const values = getNodeValues(node);
  const exposedPorts = effectiveExposedPorts(node);
  const exposedSet = new Set(exposedPorts);
  // Read RAW and strictly, exactly as graphToCode does: node data is
  // untrusted, and only the literal `true` inverts.
  const rawValues = (node.data as { values?: unknown }).values;
  const inverted = hasTrueFlag(rawValues, 'invert');
  const lit = isSplatLit(rawValues);
  const replaceColor = isSplatReplaceColor(rawValues);
  const countLine = splatCountLine(splatFacts, language);

  const setValue = (key: string, v: string | number) => {
    updateNodeData(nodeId, { values: { ...values, [key]: v } } as Partial<ShaderNodeData>);
  };
  const clearValue = (key: string) => {
    if (!splatClearable(values, key)) return;
    const next = { ...values };
    delete next[key];
    updateNodeData(nodeId, { values: next } as Partial<ShaderNodeData>);
  };
  const handleTogglePort = (portId: string) => {
    // toggleExposedPort drops the hidden port's edges with its own history
    // push; one bracket makes the whole toggle a single undo entry.
    asOneHistoryEntry(() => {
      updateNodeData(nodeId, { exposedPorts: toggleExposedPort(nodeId, exposedPorts, portId) } as Partial<ShaderNodeData>);
    });
  };
  // ONE updateNodeData, so ONE history entry (it pushes before it writes).
  const toggleInvert = () => {
    updateNodeData(nodeId, { values: splatInvertValues(values, !inverted) } as unknown as Partial<ShaderNodeData>);
  };
  const toggleLit = () => setSplatLit(nodeId, !lit);
  // ONE updateNodeData, so ONE history entry.
  const toggleReplaceColor = () => {
    updateNodeData(nodeId, { values: splatReplaceColorValues(values, !replaceColor) } as unknown as Partial<ShaderNodeData>);
  };

  const checkboxStyle: React.CSSProperties = { width: 14, height: 14, cursor: 'pointer', accentColor: 'var(--border-focus)', margin: 0 };
  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: '2px var(--space-3)',
    fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)',
  };
  const mutedStyle: React.CSSProperties = { fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' };

  const valueEditor = (portId: string) => {
    if (isSplatLightColorPort(portId)) {
      return (
        <SplatLightColorPicker
          portId={portId}
          values={values}
          className="context-menu__color"
          onPick={(hex) => setValue(portId, hex)}
          onClear={() => clearValue(portId)}
        />
      );
    }
    if (config.colorPorts.includes(portId)) {
      const stored = splatStoredColor(values[portId]);
      return (
        <>
          <PaletteColorPicker
            className="context-menu__color"
            history="bracket"
            value={stored}
            title={stored ? undefined : t(SPLAT_OWN_COLOUR_KEY, language)}
            clearColor={SPLAT_CLEAR_SWATCH}
            // The reset row only while a colour is stored (splatClearable).
            onClear={splatClearable(values, portId) ? () => clearValue(portId) : undefined}
            onPick={(hex) => setValue(portId, hex)}
          />
          {!stored && <span style={mutedStyle}>{t(SPLAT_OWN_COLOUR_KEY, language)}</span>}
        </>
      );
    }
    const setting = config.settings[portId];
    if (!setting) return null;
    const raw = valueNum(values[portId]);
    const shown = Number.isFinite(raw) && values[portId] !== undefined ? raw : Number(def.defaultValues?.[portId] ?? 0);
    return (
      <NumberRow
        label=""
        value={shown}
        step={setting.step}
        onCommit={(v) => setValue(portId, setting.clamp(v))}
      />
    );
  };

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">{t('Splat Settings', language)}</div>
      <div
        style={{ padding: '2px var(--space-3) var(--space-2)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}
      >
        {t('Tick a socket to wire it on the node; the value applies either way', language)}
      </div>
      {/* The loaded scene's size — a plain `title`, so the app-wide
          TooltipLayer raises the hint (the texture-memory line's form). */}
      {countLine && (
        <div
          title={t(SPLAT_COUNT_HINT_KEY, language)}
          style={{ padding: '0 var(--space-3) var(--space-2)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}
        >
          {countLine}
        </div>
      )}
      {config.sections.map((section) => (
        <div key={section.label}>
          <div className="context-menu__divider" />
          <div className="context-menu__category">{t(section.label, language)}</div>
          {section.label === 'Light' && (
            <div style={rowStyle}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }} title={t(SPLAT_LIT_HINT_KEY, language)}>
                <input
                  type="checkbox"
                  checked={lit}
                  onChange={toggleLit}
                  style={checkboxStyle}
                />
                {t(SPLAT_LIT_KEY, language)}
              </label>
            </div>
          )}
          {section.ports.map((portId) => {
            const port = def.inputs.find((p) => p.id === portId);
            if (!port) return null;
            // The light's rows only while it is on — they do nothing otherwise —
            // or while a wire reaches one (see `edges`).
            if (!lit && SPLAT_LIGHT_PORTS.includes(portId) && !edges.some((e) => e.target === nodeId && e.targetHandle === portId)) return null;
            return (
              <div key={portId} style={rowStyle}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', minWidth: 120 }} title={t('Show socket', language)}>
                  <input
                    type="checkbox"
                    checked={exposedSet.has(portId)}
                    onChange={() => handleTogglePort(portId)}
                    style={checkboxStyle}
                  />
                  {portLabel(port.label, language)}
                </label>
                {valueEditor(portId)}
              </div>
            );
          })}
          {section.ports.includes('color') && (
            <div style={rowStyle}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }} title={t(SPLAT_REPLACE_COLOR_HINT_KEY, language)}>
                <input
                  type="checkbox"
                  checked={replaceColor}
                  onChange={toggleReplaceColor}
                  style={checkboxStyle}
                />
                {t(SPLAT_REPLACE_COLOR_KEY, language)}
              </label>
            </div>
          )}
          {section.ports.includes('cut') && (
            <div style={rowStyle}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }} title={t(SPLAT_INVERT_HINT_KEY, language)}>
                <input
                  type="checkbox"
                  checked={inverted}
                  onChange={toggleInvert}
                  style={checkboxStyle}
                />
                {t(SPLAT_INVERT_KEY, language)}
              </label>
            </div>
          )}
        </div>
      ))}
      <div className="context-menu__divider" />
      <NodeActions nodeId={nodeId} />
      <button className="context-menu__item" onClick={closeContextMenu}>
        {t('Close', language)}
      </button>
    </div>
  );
}
