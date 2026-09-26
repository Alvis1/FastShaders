import { useAppStore } from '@/store/useAppStore';
import { valueNum } from '@/utils/valueCoerce';
import { t, portLabel } from '@/i18n';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getNodeValues } from '@/types';
import type { AppNode, ShaderNodeData } from '@/types';
import { effectiveExposedPorts, toggleExposedPort } from '@/utils/exposedPorts';
import { asOneHistoryEntry } from '@/utils/historyGesture';
import { splatCountLine, SPLAT_COUNT_HINT_KEY } from '@/utils/splatCount';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import { NumberRow, NodeActions } from './menuShared';
import {
  SPLAT_NODE_CONFIG,
  SPLAT_OWN_COLOUR_KEY,
  SPLAT_CLEAR_SWATCH,
  splatStoredColor,
  splatClearable,
} from '../nodes/SplatOutputNode';

/** The one splat setting that is not a socket: keep the OUTSIDE of the cut
 *  instead of the inside. Rendered in the Cut section, after Feather. */
export const SPLAT_INVERT_KEY = 'Invert cut';
export const SPLAT_INVERT_HINT_KEY =
  'Remove the splats where Cut is below zero instead of above it — a distance field wired to Cut then keeps its outside.';

/**
 * `values` with Invert switched: `invert: true` added, or the key DELETED —
 * never `false`, so a node switched back off is byte-for-byte the node that
 * was never touched (the absent-key rule; emission counts only the literal
 * `true`). A fresh object; the input is never mutated.
 */
export function splatInvertValues(values: Readonly<Record<string, unknown>>, on: boolean): Record<string, unknown> {
  const next: Record<string, unknown> = { ...values };
  if (on) next.invert = true;
  else delete next.invert;
  return next;
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
 * Two things the march menu does not have:
 *
 *   • INVERT CUT, a checkbox writing `values.invert = true` or deleting the key
 *     — never `false`, so an untouched node and a node switched back off are
 *     the same document (the absent-key rule; emission counts only the literal
 *     `true`). ONE `updateNodeData`, so ONE undo entry.
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
  const def = NODE_REGISTRY.get('splatOutput');
  if (!node || !def) return null;

  const config = SPLAT_NODE_CONFIG;
  const values = getNodeValues(node);
  const exposedPorts = effectiveExposedPorts(node);
  const exposedSet = new Set(exposedPorts);
  // Read RAW and strictly, exactly as graphToCode does: node data is
  // untrusted, and only the literal `true` inverts.
  const rawValues = (node.data as { values?: unknown }).values;
  const inverted = !!rawValues && typeof rawValues === 'object' && (rawValues as Record<string, unknown>).invert === true;
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

  const checkboxStyle: React.CSSProperties = { width: 14, height: 14, cursor: 'pointer', accentColor: 'var(--border-focus)', margin: 0 };
  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: '2px var(--space-3)',
    fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)',
  };
  const mutedStyle: React.CSSProperties = { fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' };

  const valueEditor = (portId: string) => {
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
          {section.ports.map((portId) => {
            const port = def.inputs.find((p) => p.id === portId);
            if (!port) return null;
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
