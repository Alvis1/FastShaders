import type { CSSProperties } from 'react';
import type { NodeDefinition } from '@/types';
import { getTypeColor } from '@/utils/colorUtils';
import { getColormap, colormapGradientCss } from '@/utils/colormaps';
import { formatNodeLabel } from '@/i18n';
import { useAppStore } from '@/store/useAppStore';
import { buildRows } from './ShaderNode';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import {
  NodeGlyph,
  hasNodeGlyph,
  nodeBox,
  nodeSockets,
  nodeTextScale,
  nodeJustify,
  nodeScale,
  nodeArtStyle,
  type GlyphDesign,
} from './glyphs/NodeGlyph';

/**
 * NodeVisual — THE static replica of the live ShaderNode, shared by every
 * surface that previews a node without running it:
 *
 *   · the asset-browser cards (NodePreviewCard → ShaderCardContent)
 *   · the node-editor.html overview table (which renders those same cards)
 *   · the Node Designer's stage (node-designer.html), which renders THIS
 *     component with the draft design — so what the designer shows is, by
 *     construction, what the editor draws. The designer used to carry its own
 *     hand-written DOM/CSS mimic of ShaderNode, and every drift incident
 *     (missing dataviz nodes, the blank colormap, "not precise" spacing) was
 *     that copy going stale.
 *
 * Same classes, same CSS files, same buildRows, same designer-override
 * helpers, real DragNumberInput. ShaderNode itself stays the live
 * implementation (React Flow handles, store wiring); this component mirrors
 * its markup per NODE_DESIGN_REQUIREMENTS — change them together.
 *
 * Inert by default (cards wrap it in pointer-events:none). With
 * `interactive`, the designer's widgets accept input and the glyph/art/socket
 * elements opt back into pointer events so the designer's drag gestures can
 * reach them (the designer binds those by delegation on its stage).
 */

/** One input socket's preview state (Node Designer's "Preview states"). */
export interface PortPreviewState {
  /** 'un' = unconnected (editable value) · 'live' = connected, live value
   *  (blue) · 'inf' = connected, inferred range (gray). */
  mode: 'un' | 'live' | 'inf';
  /** Channel count of the arriving edge (1–4) — drives the body stack. */
  ch: number;
  /** Value / range text shown beside the socket while connected. */
  val: string;
}

export interface NodeVisualProps {
  def: NodeDefinition;
  catColor: string;
  costColor: string;
  costTextColor: string;
  costScale: number;
  cost: number;
  headerTextColor: string;
  /** Draft design override (Node Designer) — replaces the saved CUSTOM_GLYPHS
   *  entry outright. Absent → the saved design, exactly like the app. */
  design?: GlyphDesign;
  /** Header label override (the designer shows the bilingual display label). */
  headerText?: string;
  /** Canvas semantics: designer width is EXACT (width + minWidth), matching
   *  the live node. Default (cards): width is a FLOOR so a long name in any
   *  language can stretch the card instead of wrapping into fragments. */
  exactWidth?: boolean;
  /** Per-input preview states. Missing key = unconnected. */
  portStates?: Record<string, PortPreviewState>;
  /** Display values overriding def.defaultValues (designer scrubbing). */
  values?: Record<string, string | number>;
  /** Live value edits (designer). Absent → widgets are display-only. */
  onValueChange?: (key: string, value: number | string) => void;
  /** Designer mode: widgets accept input; glyph/art/sockets get pointer
   *  events + data attributes for the designer's delegated gestures. */
  interactive?: boolean;
  /** Socket-drag snap ruler along the left/right border (designer). */
  snapCol?: 'l' | 'r' | null;
  wrapClassName?: string;
  cardClassName?: string;
}

const noop = () => {};
/** Node-body stack: px down per extra channel layer (mirrors ShaderNode). */
const STACK_STEP_Y = 3;

export function NodeVisual({
  def,
  catColor,
  costColor,
  costTextColor,
  costScale,
  cost,
  headerTextColor,
  design,
  headerText,
  exactWidth = false,
  portStates,
  values,
  onValueChange,
  interactive = false,
  snapCol = null,
  wrapClassName = '',
  cardClassName = '',
}: NodeVisualProps) {
  const language = useAppStore((s) => s.language);
  const box = nodeBox(def.type, design);
  const textScale = nodeTextScale(def.type, design);
  const sockets = nodeSockets(def.type, design);
  const justify = nodeJustify(def.type, design);
  const gScale = nodeScale(def.type, design);
  const dv = def.defaultValues ?? {};

  const stateOf = (id: string): PortPreviewState | null => portStates?.[id] ?? null;
  const connected = (id: string) => (stateOf(id)?.mode ?? 'un') !== 'un';

  // Multi-channel stack: appears only when multi-channel data ARRIVES on a
  // connected input — widest count wins, N channels read as N total cards
  // (mirrors ShaderNode's inChannels).
  let inCh = 1;
  for (const inp of def.inputs) {
    const s = stateOf(inp.id);
    if (s && s.mode !== 'un') inCh = Math.max(inCh, Math.min(Math.max(s.ch, 1), 4));
  }
  const stackLayerCount = Math.min(inCh, 4) - 1;

  // Mirrors ShaderNode's wrapper (cost scale) + card (border/width/text) split.
  const wrapStyle: CSSProperties = {
    position: 'relative',
    width: 'fit-content',
    transform: `scale(${costScale})`,
    transformOrigin: 'top left',
  };
  const nodeStyle: CSSProperties = {
    background: 'var(--node-bg)',
    border: `1.5px solid ${catColor}`,
  };
  if (box.width) {
    if (exactWidth) {
      // Live-node semantics (designer stage): the authored width is the
      // PREFERRED width and `min-content` the floor — identical to ShaderNode,
      // so the stage shows what the canvas will do. The node keeps its designed
      // width while the content fits and widens only when it cannot.
      nodeStyle.width = box.width;
      nodeStyle.minWidth = 'min-content';
    } else {
      // Card semantics: floor only, so the card GROWS (fit-content) to keep a
      // long name like "Vektoriālais reizinājums" on one line — at most two
      // rows via the CSS clamp — instead of a tall stack of fragments.
      nodeStyle.minWidth = box.width;
    }
  }
  if (textScale !== 1) (nodeStyle as Record<string, string | number>)['--node-text-scale'] = textScale;
  // While stacked, the card drops its own shadow — only the deepest layer
  // casts the single group shadow (no shadow between cards).
  if (stackLayerCount > 0) nodeStyle.boxShadow = 'none';

  const calcTop = (off: number) => `calc(50% ${off < 0 ? '-' : '+'} ${Math.abs(off)}px)`;
  const num = (k: string) => Number(values?.[k] ?? dv[k] ?? 0);
  const change = onValueChange ?? noop;
  const interactiveStyle: CSSProperties | undefined = interactive ? { pointerEvents: 'auto' } : undefined;

  /** Static socket dot with the live handle's exact classes/geometry.
   *  data-port/data-io let the designer's delegated drag/click gestures
   *  identify sockets without owning the DOM. */
  const StaticHandle = ({ side, dataType, port, label, style }: {
    side: 'left' | 'right';
    dataType: Parameters<typeof getTypeColor>[0];
    port: string;
    label?: string;
    style?: CSSProperties;
  }) => (
    <span
      className={`react-flow__handle react-flow__handle-${side} typed-handle`}
      title={label}
      data-port={port}
      data-io={side === 'left' ? 'in' : 'out'}
      style={{ background: getTypeColor(dataType), ...style }}
    />
  );

  /** Connected-input value label — the SAME element ShaderNode renders. */
  const EdgeVal = ({ state }: { state: PortPreviewState }) => (
    <span
      className="shader-node__edge-val"
      style={state.mode === 'live' ? { color: '#2D6CDF' } : undefined}
      title={state.mode === 'live' ? 'live edge value' : 'inferred range'}
    >
      {state.val || '…'}
    </span>
  );

  /** Offset card layers behind the node body (channels − 1, so N-ch = N
   *  cards). Deeper layers paint first (z −1, −2, −3) so every layer's bottom
   *  strip stays visible; the deepest carries the single group shadow. */
  const stackLayers = stackLayerCount > 0
    ? [...Array(stackLayerCount).keys()].map((k) => (
        <div
          key={`stack-${k}`}
          className="node-base__stack"
          style={{
            transform: `translateY(${(k + 1) * STACK_STEP_Y}px)`,
            zIndex: -(k + 1),
            borderColor: catColor,
            ...(k === stackLayerCount - 1 ? { boxShadow: 'var(--shadow-node)' } : null),
          }}
        />
      ))
    : null;

  const snapColEl = snapCol ? (
    <div className={`nd-snapcol nd-snapcol--${snapCol}`} />
  ) : null;

  const cardClass = `node-base${stackLayerCount > 0 ? ' node-base--stacked' : ''}${cardClassName ? ` ${cardClassName}` : ''}`;

  // Header string, computed once so the visible text and its `title` can never
  // disagree (the header clamps at two lines — see NodeBase.css).
  const titleText =
    headerText ??
    (def.type === 'property_float'
      ? String(dv.name ?? def.label)
      : formatNodeLabel(def.label, def.type, language, false));

  const header = (
    <>
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
      )}
      <div className="node-base__header" style={{ background: costColor }}>
        {/* `title` mirrors ShaderNode's: the header clamps at two lines
            (NodeBase.css), so a name long enough to be ellipsized stays
            readable on hover. */}
        <span className="node-base__title" title={titleText} style={{ color: headerTextColor }}>
          {titleText}
        </span>
      </div>
    </>
  );

  // ── Operator layout (2-input glyph nodes) ──
  if (hasNodeGlyph(def.type, design) && def.inputs.length === 2) {
    const BODY_H = box.height ?? Math.max(52, Math.round(34 * gScale) + 10);
    const DEF_OFF = [-12.5, 12.5];
    const offOf = (id: string, i: number) => sockets[id] ?? DEF_OFF[i] ?? 0;
    const outOff = sockets['out'] ?? 0;
    return (
      <div className={`${wrapClassName}`.trim()} style={wrapStyle}>
        {stackLayers}
        <div className={cardClass} style={nodeStyle}>
          {header}
          <div className="shader-node__op" style={{ height: BODY_H, ...(box.width ? { minWidth: 0 } : null) }}>
            <div className="shader-node__op-glyph" data-nd-glyph={interactive ? '' : undefined} style={interactiveStyle}>
              <NodeGlyph type={def.type} value={num('value')} size={34} design={design} />
            </div>
            {def.inputs.map((inp, i) => {
              const s = stateOf(inp.id);
              return (
                <div
                  key={`v-${inp.id}`}
                  className={`shader-node__op-val shader-node__op-val--${justify}`}
                  style={{ top: BODY_H / 2 + offOf(inp.id, i) }}
                >
                  {s && s.mode !== 'un' ? (
                    <EdgeVal state={s} />
                  ) : (
                    <DragNumberInput
                      compact
                      step={inp.dataType === 'int' ? 1 : undefined}
                      value={num(inp.id)}
                      onChange={(v) => change(inp.id, inp.dataType === 'int' ? Math.round(v) : v)}
                    />
                  )}
                </div>
              );
            })}
            {def.inputs.map((inp, i) => (
              <StaticHandle key={`h-${inp.id}`} side="left" dataType={inp.dataType} port={inp.id} label={inp.label}
                style={{ top: `${BODY_H / 2 + offOf(inp.id, i)}px` }} />
            ))}
            {def.outputs[0] && (
              <StaticHandle side="right" dataType={def.outputs[0].dataType} port={def.outputs[0].id} label={def.outputs[0].label}
                style={{ top: `${BODY_H / 2 + outOff}px` }} />
            )}
            {snapColEl}
          </div>
        </div>
      </div>
    );
  }

  // ── Rows layout (ShaderNode's rows branch) ──
  const rows = buildRows(def);
  const outMoved = sockets['out'] != null && !!def.outputs[0];
  return (
    <div className={`${wrapClassName}`.trim()} style={wrapStyle}>
      {stackLayers}
      {/* (micNode never reaches NodeVisual — its flow type is 'mic', and every
          mic surface renders through MicNode/MicCardContent instead.) */}
      <div className={cardClass} style={nodeStyle}>
        {header}
        {/* Colormap: the node's ART is its real ramp — same gradient helper as
            the canvas node, the settings menu and the picker, so no surface
            can show a different map. Designer dx/dy/scale move/grow it as a
            purely visual transform (nodeArtStyle). */}
        {def.type === 'colormap' && (
          <div
            className="shader-node__colormap-strip"
            data-nd-art={interactive ? '' : undefined}
            style={{
              // reverse/levels included, exactly as ShaderNode passes them —
              // one gradient helper is only "one picture" if every caller
              // hands it the same arguments.
              background: colormapGradientCss(
                getColormap(values?.map ?? dv.map),
                Number(values?.reverse ?? dv.reverse ?? 0) >= 0.5,
                Math.floor(Number(values?.levels ?? dv.levels ?? 0)),
              ),
              ...nodeArtStyle(def.type, design),
              ...interactiveStyle,
            }}
          />
        )}
        <div className="shader-node__region" style={{ position: 'relative', ...(box.height ? { height: box.height } : null) }}>
          {hasNodeGlyph(def.type, design) && (
            <div className="shader-node__glyph" data-nd-glyph={interactive ? '' : undefined} style={interactiveStyle}>
              <NodeGlyph type={def.type} value={num('value')} size={30} design={design} />
            </div>
          )}

          <div className="node-base__body">
            {rows.map((row, i) => {
              const inputMoved = row.input ? sockets[row.input.id] != null : false;
              const state = row.input ? stateOf(row.input.id) : null;
              const isConnected = row.input ? connected(row.input.id) : false;
              const showInlineValue = row.input && !row.settingKey && !isConnected;
              if (inputMoved) {
                return (
                  <div key={i} className="node-base__row shader-node__row">
                    <div className="shader-node__left" />
                    <div className="shader-node__right">
                      {row.output && !(outMoved && row.output === def.outputs[0]) && (
                        <StaticHandle side="right" dataType={row.output.dataType} port={row.output.id} label={row.output.label} />
                      )}
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className="node-base__row shader-node__row">
                  <div className="shader-node__left">
                    {row.input && (
                      <StaticHandle side="left" dataType={row.input.dataType} port={row.input.id} label={row.input.label} />
                    )}
                    {row.input && isConnected && state && <EdgeVal state={state} />}
                    {def.type === 'slider' && row.settingKey === 'value' && (
                      <input type="range" className="shader-node__slider nodrag"
                        min={num('min')} max={Number(values?.max ?? dv.max ?? 1)} step={0.01}
                        value={num('value')}
                        onChange={interactive ? (e) => change('value', Number(e.target.value)) : noop}
                        readOnly={!interactive} />
                    )}
                    {row.settingKey && row.settingType === 'number' && !isConnected && !(def.type === 'slider' && row.settingKey === 'value') && (
                      <DragNumberInput compact value={num(row.settingKey)} onChange={(v) => change(row.settingKey!, v)} />
                    )}
                    {/* Colour row. The REAL picker only under `interactive`
                        (the Node Designer's stage); everywhere else — asset
                        tiles, the node-editor overview — an inert `<span>`
                        carrying the SAME `.palette-swatch` classes, which is
                        the OutputCardContent precedent for a card that must
                        show a real widget without being one.

                        Not "always the picker, made inert by the card's
                        pointer-events: none wrapper": that wrapper stops the
                        pointer but not the keyboard, so every colour row on
                        every palette tile would become a tab stop that opens a
                        real popover from a static replica. Not "keep the old
                        read-only colour input" either — `readOnly` is not
                        honoured there, and the two elements paint their fill
                        differently (UA swatch vs `background`), which is
                        exactly the drift the one-node-one-look rule forbids.

                        `history="none"`: the designer's `onValueChange` writes
                        its own session-only preview model, never the graph, so
                        bracketing here would push a dead undo entry and wipe
                        the redo stack on every pick. */}
                    {row.settingKey && row.settingType === 'color' && (
                      interactive ? (
                        <PaletteColorPicker
                          className="shader-node__input-color"
                          history="none"
                          value={String(values?.[row.settingKey] ?? dv[row.settingKey] ?? '#ff0000')}
                          onPick={(hex) => change(row.settingKey!, hex)}
                        />
                      ) : (
                        <span
                          className="palette-swatch shader-node__input-color"
                          style={{ background: String(values?.[row.settingKey] ?? dv[row.settingKey] ?? '#ff0000') }}
                        />
                      )
                    )}
                    {row.settingType === 'vec3' && row.vecBaseKey && (
                      <span className="shader-node__vec-group">
                        {['x', 'y', 'z'].map((a) => (
                          <DragNumberInput key={a} compact value={num(`${row.vecBaseKey}_${a}`)} onChange={(v) => change(`${row.vecBaseKey}_${a}`, v)} />
                        ))}
                      </span>
                    )}
                    {row.settingType === 'vec2' && row.vecBaseKey && (
                      <span className="shader-node__vec-group">
                        {['x', 'y'].map((a) => (
                          <DragNumberInput key={a} compact value={num(`${row.vecBaseKey}_${a}`)} onChange={(v) => change(`${row.vecBaseKey}_${a}`, v)} />
                        ))}
                      </span>
                    )}
                    {showInlineValue && (
                      <DragNumberInput
                        compact
                        step={row.input!.dataType === 'int' ? 1 : undefined}
                        value={num(row.input!.id)}
                        onChange={(v) => change(row.input!.id, row.input!.dataType === 'int' ? Math.round(v) : v)}
                      />
                    )}
                  </div>
                  <div className="shader-node__right">
                    {row.output && !(outMoved && row.output === def.outputs[0]) && (
                      <StaticHandle side="right" dataType={row.output.dataType} port={row.output.id} label={row.output.label} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Detached (designer-moved) inputs: value follows its socket */}
          {def.inputs.map((inp) => {
            const off = sockets[inp.id];
            if (off == null) return null;
            const s = stateOf(inp.id);
            return (
              <div key={`mv-${inp.id}`} style={{ display: 'contents' }}>
                <div className={`shader-node__op-val shader-node__op-val--${justify}`} style={{ top: calcTop(off) }}>
                  {s && s.mode !== 'un' ? (
                    <EdgeVal state={s} />
                  ) : (
                    <DragNumberInput compact step={inp.dataType === 'int' ? 1 : undefined}
                      value={num(inp.id)}
                      onChange={(v) => change(inp.id, inp.dataType === 'int' ? Math.round(v) : v)} />
                  )}
                </div>
                <StaticHandle side="left" dataType={inp.dataType} port={inp.id} label={inp.label} style={{ top: calcTop(off) }} />
              </div>
            );
          })}
          {outMoved && (
            <StaticHandle side="right" dataType={def.outputs[0].dataType} port={def.outputs[0].id} label={def.outputs[0].label}
              style={{ top: calcTop(sockets['out']) }} />
          )}
          {snapColEl}
        </div>
      </div>
    </div>
  );
}
