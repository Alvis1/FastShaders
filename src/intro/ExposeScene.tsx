/**
 * Intro scene — sockets you can expose: a node's parameter (the noise's
 * "scale") and an Output channel (Emissive), each ticked in the node's own
 * right-click menu, then wired.
 *
 * The menus are the app's rows (`ParamRowView` from the generic node menu,
 * `OutputPortToggles` from the Output's), cropped to the part that does this;
 * what a tick shows is the cards' own socket placement (`NoiseCardContent`'s
 * `exposedPorts`, PreviewNode's `handleTop`; the Output's rows by its exposed
 * set). Nothing is written to the store.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Position } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { formatNodeLabel, t } from '@/i18n';
import { OUTPUT_DEFAULT_EXPOSED } from '@/utils/exposedPorts';
import {
  CardSocketLabels,
  NoiseCardContent,
  OutputCardContent,
  useCardChrome,
} from '@/components/NodeEditor/NodePreviewCard';
import { ParamRowView } from '@/components/NodeEditor/menus/ParamRow';
import { OutputPortToggles } from '@/components/NodeEditor/menus/ShaderSettingsMenu';
import { DragNumberInput } from '@/components/NodeEditor/inputs/DragNumberInput';
import { CONNECTION_RADIUS } from '@/components/NodeEditor/nodes/connectionReveal';
import { EXPOSE_CHANNEL, EXPOSE_PARAM, buildExposeTour, exposeFrame, type ExposeState, type ExposeTour } from './exposeTour';
import { IntroStage, centre, paintCursor, placeMenu, stageMeasurer, useIntroStage, type Box } from './IntroStage';
import {
  IntroConnectionLine,
  IntroWire,
  connectionEnd,
  connectionPath,
  useWireInk,
  wirePaths,
  wiredValue,
  type SceneEdge,
} from './sceneGraph';
import type { Point } from './timeline';

const NOISE_AT: Point = { x: 64, y: 110 };
const OUTPUT_AT: Point = { x: 372, y: 52 };
const AWAY: Point = { x: 250, y: 268 };

const noiseDef = NODE_REGISTRY.get('perlin')!;
const outputDef = NODE_REGISTRY.get('output')!;
const WIRE: SceneEdge = { source: 'intro-noise', sourceHandle: 'out', target: 'intro-output', targetHandle: EXPOSE_CHANNEL };
const WITH_CHANNEL = [...OUTPUT_DEFAULT_EXPOSED, EXPOSE_CHANNEL];
const noop = () => {};

const IDLE: ExposeState = {
  menu: 'none', param: false, channel: false, dragging: false, wired: false, rightClick: false, pressed: false,
};

interface Layout {
  noiseMenu: Point;
  outputMenu: Point;
  from: Point;
  to: Point;
}

export function ExposeScene() {
  const stage = useIntroStage();
  const language = useAppStore((s) => s.language);
  const ink = useWireInk();
  const noiseChrome = useCardChrome(noiseDef);
  const outputChrome = useCardChrome(outputDef);
  const wiredText = useMemo(
    () => wiredValue([{ id: WIRE.source, def: noiseDef }, { id: WIRE.target, def: outputDef }], [WIRE], WIRE).val,
    [],
  );

  const noiseRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const noiseMenuRef = useRef<HTMLDivElement>(null);
  const outputMenuRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<SVGPathElement>(null);
  const clockRef = useRef<number | null>(null);

  const [layout, setLayout] = useState<Layout | null>(null);
  const [tour, setTour] = useState<ExposeTour | null>(null);
  const [state, setState] = useState<ExposeState>(IDLE);

  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const els = [noiseRef.current, outputRef.current, probeRef.current, noiseMenuRef.current, outputMenuRef.current];
    if (!stageEl || els.some((e) => !e)) return;
    const [noiseW, outW, probe, noiseMenu, outMenu] = els as HTMLDivElement[];
    const measure = () => {
      const box = stageMeasurer(stageEl);
      if (!box) return;
      const nR = noiseW.getBoundingClientRect();
      const oR = outW.getBoundingClientRect();
      const noiseHead = box(noiseW.querySelector('.node-base__header'), nR, NOISE_AT);
      const outHead = box(outW.querySelector('.output-node__header'), oR, OUTPUT_AT);
      const from = box(noiseW.querySelector('.react-flow__handle-right[data-handleid="out"]'), nR, NOISE_AT);
      const to = box(probe.querySelector(`[data-handleid="${EXPOSE_CHANNEL}"]`), probe.getBoundingClientRect(), OUTPUT_AT);
      const nmR = noiseMenu.getBoundingClientRect();
      const omR = outMenu.getBoundingClientRect();
      const nmSize = box(noiseMenu, nmR, { x: 0, y: 0 });
      const omSize = box(outMenu, omR, { x: 0, y: 0 });
      if (!noiseHead || !outHead || !from || !to || !nmSize || !omSize) return;
      const noiseClick = centre(noiseHead);
      const outClick = centre(outHead);
      const noiseMenuAt = placeMenu(noiseClick, nmSize);
      const outputMenuAt = placeMenu(outClick, omSize);
      // The noise menu's checkboxes are its rows in order: pos, then scale.
      const paramBox = box(noiseMenu.querySelectorAll('input[type="checkbox"]')[1] ?? null, nmR, noiseMenuAt);
      const channelBox = box(outMenu.querySelector(`input[data-port="${EXPOSE_CHANNEL}"]`), omR, outputMenuAt);
      if (!paramBox || !channelBox) return;
      const fromPt = { x: from.x + from.w, y: centre(from).y };
      const toPt = { x: to.x, y: centre(to).y };
      setLayout({ noiseMenu: noiseMenuAt, outputMenu: outputMenuAt, from: fromPt, to: toPt });
      setTour(
        buildExposeTour({
          noise: noiseClick,
          output: outClick,
          paramBox: centre(paramBox as Box),
          channelBox: centre(channelBox as Box),
          away: AWAY,
          from: fromPt,
          to: toPt,
        }),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of els as HTMLDivElement[]) ro.observe(el);
    return () => ro.disconnect();
  }, [stage.scale, stage.stageRef, language]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    const line = lineRef.current;
    if (!tour || !scene || !cursor || !line) return;
    let shown: ExposeState | null = null;
    const paint = (time: number) => {
      const f = exposeFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed, rightClick: f.state.rightClick });
      if (f.state.dragging) {
        line.setAttribute('d', connectionPath(tour.geo.from, connectionEnd(f.cursor, tour.geo.to, CONNECTION_RADIUS)));
      } else {
        line.removeAttribute('d');
      }
      if (f.state !== shown) {
        shown = f.state;
        setState(f.state);
      }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(tour.wired);
      return;
    }
    let raf = 0;
    clockRef.current ??= performance.now();
    const t0 = clockRef.current;
    const loop = (now: number) => {
      paint(now - t0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tour, stage.sceneRef, stage.cursorRef]);

  const exposed = new Set(state.channel ? WITH_CHANNEL : OUTPUT_DEFAULT_EXPOSED);
  const wire = layout && state.wired ? wirePaths(layout.from, layout.to, Position.Right) : null;

  return (
    <IntroStage stage={stage}>
      <svg className="fs-intro__wires">{wire && <IntroWire ink={ink} d={wire} />}</svg>
      <CardSocketLabels.Provider value={true}>
        <div ref={noiseRef} className="react-flow__node fs-intro__node" style={{ left: NOISE_AT.x, top: NOISE_AT.y }}>
          <NoiseCardContent {...noiseChrome} exposedPorts={state.param ? [EXPOSE_PARAM] : []} />
        </div>
        <div ref={outputRef} className="react-flow__node fs-intro__node" style={{ left: OUTPUT_AT.x, top: OUTPUT_AT.y }}>
          <OutputCardContent
            {...outputChrome}
            exposedPorts={state.channel ? WITH_CHANNEL : OUTPUT_DEFAULT_EXPOSED}
            wired={state.wired ? { [EXPOSE_CHANNEL]: wiredText } : undefined}
          />
        </div>
        {/* The Output with the channel already out — never shown: where the
            new socket WILL be, so the wire can be aimed before it exists. */}
        <div ref={probeRef} className="react-flow__node fs-intro__node" style={{ left: OUTPUT_AT.x, top: OUTPUT_AT.y, visibility: 'hidden' }}>
          <OutputCardContent {...outputChrome} exposedPorts={WITH_CHANNEL} />
        </div>
      </CardSocketLabels.Provider>
      <IntroConnectionLine lineRef={lineRef} />

      {/* The node's menu (NodeSettingsMenu), cropped to its parameter rows. */}
      <div
        ref={noiseMenuRef}
        className="context-menu fs-intro__menu"
        style={{ left: layout?.noiseMenu.x ?? 0, top: layout?.noiseMenu.y ?? 0, visibility: state.menu === 'noise' ? 'visible' : 'hidden' }}
      >
        <div className="context-menu__list">
          <div className="context-menu__category">{t('Node Settings', language)}</div>
          <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-2)' }}>
              {formatNodeLabel(noiseDef.label, noiseDef.type, language)}
            </div>
          </div>
          {Object.keys(noiseDef.defaultValues ?? {}).map((key) => {
            const value = noiseDef.defaultValues?.[key];
            return (
              <ParamRowView
                key={key}
                inert
                toggle={{ exposed: key === EXPOSE_PARAM && state.param, onToggle: noop }}
                label={key}
                language={language}
              >
                {typeof value === 'number' ? <DragNumberInput value={value} onChange={noop} /> : null}
              </ParamRowView>
            );
          })}
        </div>
      </div>

      {/* The Output's menu (ShaderSettingsMenu), cropped to its channels. */}
      <div
        ref={outputMenuRef}
        className="context-menu fs-intro__menu"
        style={{ left: layout?.outputMenu.x ?? 0, top: layout?.outputMenu.y ?? 0, visibility: state.menu === 'output' ? 'visible' : 'hidden' }}
      >
        <div className="context-menu__list">
          <div className="context-menu__category">{t('Material Settings', language)}</div>
          <div className="context-menu__divider" />
          <div className="context-menu__category">{t('Pixel (Fragment) Shader', language)}</div>
          <OutputPortToggles outputDef={outputDef} exposed={exposed} onToggle={noop} language={language} inert />
        </div>
      </div>
    </IntroStage>
  );
}
