import { memo, useEffect, useMemo } from 'react';
import { valueNum } from '@/utils/valueCoerce';
import { Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { t, portLabel } from '@/i18n';
import { isActiveSinkSelector } from './activeSinkSelector';
import { effectiveExposedPorts } from '@/utils/exposedPorts';
import { useCostChrome } from './useCostChrome';
import { TypedHandle } from '../handles/TypedHandle';
import { OutputTitle } from './OutputTitle';
import { useWiredLabels } from './ShaderNode';
import { LiveEdgeValue } from './LiveEdgeValue';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import { NODE_BORDER_WIDTH } from './nodeFrame';
import type { MarchNodeConfig } from './RaymarchOutputNode';
import { isSplatLit, isSplatLightColorPort, SPLAT_LIGHT_COLOR_DEFAULTS, SPLAT_LIGHT_PORTS } from '@/utils/splatLight';
import { splatStoredColor } from '@/utils/splatColor';
import './OutputNode.css';

/**
 * The Splat Output (`splatOutput`) — the Gaussian-splat sink — wearing the
 * Output node's chrome, the Raymarch Output's way: uppercase header on the
 * cost colour, labelled sections, one labelled row per EXPOSED socket with a
 * value cell beside it. It reuses OutputNode.css outright; the frame is the
 * `output` category colour (it is a sink, and it is always offered on the
 * Output tab), and `output-node--splat` is the hook for anything that must
 * ever tell it apart.
 *
 * Sections follow what each socket does to a splat, which is also how the
 * emitted program is split (utils/sdfPartition.ts SPLAT_SCOPES):
 *   Shade — Color, Opacity   → the `shade` Fn, vec4(rgb, opacity)
 *   Cut   — Cut, Feather     → a sign test: Cut > 0 removes the splat (the
 *                              `shape` Fn's w); a splat-dependent Feather is
 *                              its own `feather` Fn
 *   Shape — Move, Size       → the `shape` Fn's move, and the footprint (a
 *                              splat-dependent Size is its own `size` Fn)
 *   Light — Light X/Y/Z,     → a LIT node's key light (utils/splatLight.ts):
 *           Light colour,      a line inside the `shade` Fn that multiplies
 *           Ambient            the colour, while the loader passes each
 *                              splat's surface normal as `n`. Switched by
 *                              "React to light" in the settings menu; its rows
 *                              show only while the node is lit (or a wire
 *                              already reaches one — no edge may point at an
 *                              unmounted socket).
 *
 * Row contract, the Output's: a WIRED socket shows the incoming value as plain
 * text; an unwired one shows its stored-value widget (the Color swatch, the
 * three numbers) or an empty cell for a socket that stores nothing (Cut,
 * Move). The Color swatch has one state the other outputs lack: with no
 * stored colour every splat keeps the colour it was captured with, so the
 * cell draws the UNSET swatch and says "Own colour"; the popover's reset row
 * returns a picked colour to that state, and is offered only while a colour is
 * stored (`splatClearable`).
 *
 * The palette tile (`SplatOutputCardContent` in NodePreviewCard.tsx) mirrors
 * this markup; change them together (the one-node-one-look convention).
 */

export const SPLAT_NODE_CONFIG: MarchNodeConfig = {
  title: 'Splat Output',
  original: 'Gaussian splat',
  sections: [
    { label: 'Shade', ports: ['color', 'opacity'] },
    { label: 'Cut', ports: ['cut', 'feather'] },
    { label: 'Shape', ports: ['move', 'size'] },
    { label: 'Light', ports: [...SPLAT_LIGHT_PORTS] },
  ],
  settings: {
    // Multiplies the splat's own alpha; 0 hides it, 1 leaves it as captured.
    opacity: { step: 0.01, decimals: 2, clamp: (v) => Math.min(1, Math.max(0, v)) },
    // The width of the soft band on the removed side of the cut; 0 is a hard cut.
    feather: { step: 0.01, decimals: 2, clamp: (v) => Math.max(0, v) },
    // A footprint multiplier. The loader caps the on-screen growth itself.
    size: { step: 0.05, decimals: 2, clamp: (v) => Math.max(0, v) },
    // The direction the light comes FROM, world space; the emitted line
    // normalises it, so only the direction matters.
    lightX: { step: 0.05, decimals: 2, clamp: (v) => v },
    lightY: { step: 0.05, decimals: 2, clamp: (v) => v },
    lightZ: { step: 0.05, decimals: 2, clamp: (v) => v },
  },
  colorPorts: ['color', 'lightColor', 'ambient'],
};

/** The UI string for a Splat Output whose Color stores nothing — every splat
 *  keeps the colour it was captured with (the emitted `c.rgb`). */
export const SPLAT_OWN_COLOUR_KEY = 'Own colour';

/** The swatch the popover's reset row previews: the UNSET look (a crossed
 *  white), since clearing returns the splat to its own colour, not to white. */
export const SPLAT_CLEAR_SWATCH = '#ffffff';

/** A stored Color the emitter will actually use (utils/splatColor.ts, which
 *  the emitter and the resync read too). */
export { splatStoredColor };

/**
 * Does `values` STORE something under `key` for the colour popover's reset row
 * to clear? The popover brackets the history BEFORE it calls `onClear`, and a
 * bracket clears the redo stack — so a reset row on a node storing nothing
 * (every fresh Splat Output) is a no-op write that still costs the user their
 * redo. Both colour sites pass `onClear` only when this holds, and `clearValue`
 * returns before writing when it does not.
 *
 * An OWN key, never `in` (`values` is a plain object, so `'toString' in values`
 * is true); and PRESENCE, not `splatStoredColor` — a value the emitter ignores
 * is still one the user must be able to clear.
 */
export function splatClearable(values: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, key);
}

/**
 * A light colour's swatch (Light colour, Ambient) — ONE component for the node
 * row and the settings menu row, which differ only in `className`. It shows
 * the stored swatch, else the default the emitter writes (never the unset
 * look: an unset light colour still lights), and the reset row returns to that
 * default — offered only while a colour is stored (`splatClearable`).
 */
export function SplatLightColorPicker({ portId, values, className, onPick, onClear }: {
  portId: 'lightColor' | 'ambient';
  values: Readonly<Record<string, unknown>>;
  className: string;
  onPick: (hex: string) => void;
  onClear: () => void;
}) {
  const dflt = SPLAT_LIGHT_COLOR_DEFAULTS[portId].hex;
  return (
    <PaletteColorPicker
      className={className}
      history="bracket"
      value={splatStoredColor(values[portId]) ?? dflt}
      clearColor={dflt}
      onClear={splatClearable(values, portId) ? onClear : undefined}
      onPick={onPick}
    />
  );
}

export const SplatOutputNode = memo(function SplatOutputNode({ id, data, selected }: NodeProps<ShaderFlowNode>) {
  const def = NODE_REGISTRY.get('splatOutput')!;
  const config = SPLAT_NODE_CONFIG;
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const setActiveOutput = useAppStore((s) => s.setActiveOutput);
  const language = useAppStore((s) => s.language);
  // Is THIS node the active sink? (utils/sdfPartition.ts `activeSink`.)
  const activeSel = useMemo(() => isActiveSinkSelector(id), [id]);
  const isActive = useAppStore(activeSel);
  const cost = data.cost ?? 0;
  // Only EXPOSED sockets render — Color, Opacity, Cut and Move by default,
  // Feather and Size one tick away in the settings menu (utils/exposedPorts.ts
  // SPLAT_DEFAULT_EXPOSED).
  const exposedList = effectiveExposedPorts({ id, data } as unknown as ShaderFlowNode);
  const exposedKey = exposedList.join('|');
  const exposed = useMemo(() => new Set(exposedKey.split('|')), [exposedKey]);
  const lit = isSplatLit((data as { values?: unknown }).values);
  const { costColor, headerTextColor, costTextColor } = useCostChrome(cost);
  const values = getNodeValues({ id, data } as unknown as ShaderFlowNode);

  // What is arriving on each wired socket (useWiredLabels: the cheap-string
  // key, the unwrapped-edge rule).
  const wiredLabels = useWiredLabels(id);

  /** Is this socket's row on the node? Exposed — and a Light socket only
   *  while the node is lit, or when a wire already reaches it. */
  const shown = (portId: string) =>
    exposed.has(portId) && (lit || !SPLAT_LIGHT_PORTS.includes(portId) || wiredLabels.has(portId));
  // Handles mount and unmount with the SET of shown rows — the exposed list,
  // `lit`, and (while unlit) which Light sockets a wire reaches — so React
  // Flow must re-measure on every change of that set, or an edge into a
  // freshly shown socket (an undo bringing a wire back) stays undrawn until a
  // reload. Keyed on the set itself, so no input to it can be forgotten.
  const handleKey = def.inputs.filter((p) => shown(p.id)).map((p) => p.id).join('|');
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, handleKey, updateNodeInternals]);

  const setValue = (key: string, v: string | number) => {
    updateNodeData(id, { values: { ...values, [key]: v } });
  };
  const clearValue = (key: string) => {
    if (!splatClearable(values, key)) return;
    const next = { ...values };
    delete next[key];
    updateNodeData(id, { values: next });
  };

  const cell = (portId: string) => {
    const wired = wiredLabels.get(portId);
    if (wired) {
      return <LiveEdgeValue className="shader-node__edge-val output-node__val" {...wired} />;
    }
    if (isSplatLightColorPort(portId)) {
      return (
        <SplatLightColorPicker
          portId={portId}
          values={values}
          className="output-node__val"
          onPick={(hex) => setValue(portId, hex)}
          onClear={() => clearValue(portId)}
        />
      );
    }
    if (config.colorPorts.includes(portId)) {
      const stored = splatStoredColor(values[portId]);
      return (
        <PaletteColorPicker
          className="output-node__val"
          // The stored colour IS the graph (it emits `color(0x...)` in the
          // shade Fn), so this site is undoable and takes the bracket.
          history="bracket"
          value={stored}
          title={stored ? undefined : t(SPLAT_OWN_COLOUR_KEY, language)}
          clearColor={SPLAT_CLEAR_SWATCH}
          // The reset row only while a colour is stored (splatClearable).
          onClear={splatClearable(values, portId) ? () => clearValue(portId) : undefined}
          onPick={(hex) => setValue(portId, hex)}
        />
      );
    }
    const setting = config.settings[portId];
    if (setting) {
      const stored = valueNum(values[portId]);
      const shown = Number.isFinite(stored) && values[portId] !== undefined
        ? stored
        : Number(def.defaultValues?.[portId] ?? 0);
      return (
        <DragNumberInput
          compact
          className="output-node__val"
          value={shown}
          step={setting.step}
          decimals={setting.decimals}
          onChange={(v) => setValue(portId, setting.clamp(v))}
        />
      );
    }
    // Cut and Move store nothing; an empty cell keeps the label column vertical.
    return <span className="output-node__val" />;
  };

  const rows = (ids: string[]) =>
    def.inputs.filter((p) => ids.includes(p.id) && shown(p.id)).map((port) => (
      <div key={port.id} className="output-node__row">
        <TypedHandle type="target" position={Position.Left} id={port.id} dataType={port.dataType} label={port.label} />
        {cell(port.id)}
        <span className="output-node__port-label">{portLabel(port.label, language)}</span>
      </div>
    ));

  return (
    <div
      className={`output-node output-node--splat ${selected ? 'output-node--selected' : ''}${isActive ? '' : ' output-node--inactive'}`}
      style={{ background: 'var(--node-bg)', border: `${NODE_BORDER_WIDTH} solid var(--cat-output)` }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>
          {cost}
        </span>
      )}
      <div className="output-node__header" style={{ background: costColor }}>
        <OutputTitle title={config.title} type="splatOutput" original={config.original} language={language} color={headerTextColor} />
      </div>
      <div className="output-node__material">
        {/* The activation control, exactly the Output's: solid while this node
            is the active sink (PreviewLink anchors its wire here), hollow
            otherwise; a click makes it active. See OutputNode.tsx. */}
        <button
          type="button"
          className={`output-node__preview-socket nodrag${isActive ? '' : ' output-node__preview-socket--inactive'}`}
          aria-pressed={isActive}
          aria-label={t(isActive ? 'Rendering this output' : 'Render this output', language)}
          title={t(isActive ? 'This output drives the preview' : 'Click to render this output instead', language)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setActiveOutput(id); }}
        />
        {/* A section whose every socket is hidden is skipped outright — an
            empty labelled band would read as a broken node. */}
        {config.sections.filter((section) => section.ports.some(shown)).map((section, i) => (
          <div key={section.label}>
            {i > 0 && <div className="output-node__subdivider" />}
            <div className="output-node__section">
              <div className="output-node__section-label">{t(section.label, language)}</div>
              <div className="output-node__ports">{rows(section.ports)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});
