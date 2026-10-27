/**
 * Intro scene — a Property node is a uniform: the 3D view lists it with a
 * slider, dragging it changes the RUNNING shader at once while the node keeps
 * its number, and "Set as default" writes the tuned value into the node.
 *
 * The 3D view is the real preview (IntroPreview): the drag posts `fs:uniform`
 * as the pane's slider does, and the bake is a graph change — a new module,
 * swapped in hot. The panel is the pane's own uniform rows (its classes, the
 * bounds `seedBounds` gives a fresh uniform, the override marks), drawn here
 * because the pane's panel lives inside ShaderPreview, which owns the store.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Position } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { t } from '@/i18n';
import { graphToCode } from '@/engine/graphToCode';
import { buildPreviewShaderModule } from '@/engine/tslToPreviewHTML';
import { seedBounds } from '@/utils/uniformOverride';
import { formatFieldNumber } from '@/utils/numberField';
import { NumberField } from '@/components/inputs/NumberField';
import {
  CardSocketLabels,
  NoiseCardContent,
  OutputCardContent,
  ShaderCardContent,
  useCardChrome,
} from '@/components/NodeEditor/NodePreviewCard';
import { IntroPreview } from './IntroPreview';
import { UNIFORM_NAME, UNIFORM_START, buildUniformTour, uniformFrame, type UniformState, type UniformTour } from './uniformTour';
import { IntroStage, centre, paintCursor, stageMeasurer, useIntroStage } from './IntroStage';
import { IntroWire, sceneNodes, toAppEdges, useWireInk, wiredValue, wirePaths, type SceneEdge } from './sceneGraph';
import type { Point } from './timeline';

const ZOOM = 0.68;
const PROP_AT: Point = { x: 16, y: 170 };
const NOISE_AT: Point = { x: 150, y: 30 };
const OUTPUT_AT: Point = { x: 300, y: 110 };
const PANE = { x: 318, y: 14, w: 230, h: 272 };

const propDef = NODE_REGISTRY.get('property_float')!;
const noiseDef = NODE_REGISTRY.get('perlin')!;
const outputDef = NODE_REGISTRY.get('output')!;
const PROP = 'intro-scale';
const NOISE = 'intro-noise';
const OUTPUT = 'intro-output';
const SCENE = [
  { id: PROP, def: propDef },
  { id: NOISE, def: noiseDef },
  { id: OUTPUT, def: outputDef },
];
const EDGES: SceneEdge[] = [
  { source: PROP, sourceHandle: 'out', target: NOISE, targetHandle: 'scale' },
  { source: NOISE, sourceHandle: 'out', target: OUTPUT, targetHandle: 'color' },
];
const BOUNDS = seedBounds(UNIFORM_START);
const noop = () => {};

const IDLE: UniformState = { value: UNIFORM_START, baked: false, pressed: false };

/** The graph with the Property node holding `value`, as code and module. */
function shaderFor(value: number) {
  const nodes = sceneNodes(SCENE);
  for (const n of nodes) {
    if (n.id === PROP) (n.data as { values: Record<string, unknown> }).values = { value, name: UNIFORM_NAME };
    if (n.id === NOISE) (n.data as { exposedPorts?: string[] }).exposedPorts = ['scale'];
  }
  const code = graphToCode(nodes, toAppEdges(EDGES)).code;
  return { tsl: code, module: buildPreviewShaderModule(code) };
}

export function UniformScene() {
  const stage = useIntroStage();
  const language = useAppStore((s) => s.language);
  const ink = useWireInk();
  const propChrome = useCardChrome(propDef);
  const noiseChrome = useCardChrome(noiseDef);
  const outputChrome = useCardChrome(outputDef);
  const colorText = useMemo(() => wiredValue(SCENE, EDGES, EDGES[1], { compact: true }).val, []);

  const propRef = useRef<HTMLDivElement>(null);
  const noiseRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<number | null>(null);

  const [wires, setWires] = useState<Array<{ wire: string; arrows: string }>>([]);
  const [tour, setTour] = useState<UniformTour | null>(null);
  const [state, setState] = useState<UniformState>(IDLE);

  const nodeValue = state.baked ? state.value : UNIFORM_START;
  const shader = useMemo(() => shaderFor(nodeValue), [nodeValue]);
  const start = useMemo(() => shaderFor(UNIFORM_START), []);
  const over = !state.baked && state.value !== UNIFORM_START;
  const uniforms = useMemo(() => {
    const u: Record<string, number> = {};
    if (over) u[UNIFORM_NAME] = state.value;
    return u;
  }, [over, state.value]);

  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const els = [propRef.current, noiseRef.current, outputRef.current, panelRef.current];
    if (!stageEl || els.some((e) => !e)) return;
    const [propW, noiseW, outW, panel] = els as HTMLDivElement[];
    const measure = () => {
      const box = stageMeasurer(stageEl);
      if (!box) return;
      const base = stageEl.getBoundingClientRect();
      const o = { x: 0, y: 0 };
      const flow = (p: Point) => ({ x: p.x / ZOOM, y: p.y / ZOOM });
      const right = (el: Element | null) => {
        const b = box(el, base, o);
        return b ? flow({ x: b.x + b.w, y: centre(b).y }) : null;
      };
      const left = (el: Element | null) => {
        const b = box(el, base, o);
        return b ? flow({ x: b.x, y: centre(b).y }) : null;
      };
      const a1 = right(propW.querySelector('[data-port="out"][data-io="out"]'));
      const b1 = left(noiseW.querySelector('[data-handleid="scale"]'));
      const a2 = right(noiseW.querySelector('.react-flow__handle-right[data-handleid="out"]'));
      const b2 = left(outW.querySelector('[data-handleid="color"]'));
      const slider = box(panel.querySelector('.shader-preview__uniform-slider'), base, o);
      const btn = box(panel.querySelector('.shader-preview__uniforms-default-btn'), base, o);
      if (!a1 || !b1 || !a2 || !b2 || !slider || !btn) return;
      setWires([wirePaths(a1, b1, Position.Right), wirePaths(a2, b2, Position.Right)]);
      // The thumb travels the track inset by half its own width (~6px).
      setTour(
        buildUniformTour({
          track: { x0: slider.x + 6, x1: slider.x + slider.w - 6, y: centre(slider).y },
          bounds: BOUNDS,
          setDefault: centre(btn),
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
    if (!tour || !scene || !cursor) return;
    let shown: UniformState | null = null;
    const paint = (time: number) => {
      const f = uniformFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed });
      if (f.state !== shown) {
        shown = f.state;
        setState(f.state);
      }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(tour.tuned);
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

  const shownValue = state.value;
  const step = (BOUNDS.max - BOUNDS.min) / 200;

  return (
    <IntroStage stage={stage}>
      <div className="fs-intro__graph" style={{ transform: `scale(${ZOOM})` }}>
        <svg className="fs-intro__wires">
          {wires.map((d, i) => (
            <IntroWire key={i} ink={ink} d={d} />
          ))}
        </svg>
        <CardSocketLabels.Provider value={true}>
          <div ref={propRef} className="react-flow__node fs-intro__node" style={{ left: PROP_AT.x, top: PROP_AT.y }}>
            <ShaderCardContent {...propChrome} values={{ value: nodeValue, name: UNIFORM_NAME }} headerText={UNIFORM_NAME} />
          </div>
          <div ref={noiseRef} className="react-flow__node fs-intro__node" style={{ left: NOISE_AT.x, top: NOISE_AT.y }}>
            <NoiseCardContent {...noiseChrome} exposedPorts={['scale']} />
          </div>
          <div ref={outputRef} className="react-flow__node fs-intro__node" style={{ left: OUTPUT_AT.x, top: OUTPUT_AT.y }}>
            <OutputCardContent {...outputChrome} wired={{ color: colorText }} />
          </div>
        </CardSocketLabels.Provider>
      </div>

      <div className="fs-intro__pane" style={{ left: PANE.x, top: PANE.y, width: PANE.w, height: PANE.h }}>
        <IntroPreview tslCode={start.tsl} module={shader.module} uniforms={uniforms} />
        {/* The pane's uniform panel (ShaderPreview's rows and classes). */}
        <div ref={panelRef} className="shader-preview__uniforms">
          <button
            type="button"
            tabIndex={-1}
            className={`shader-preview__uniforms-default-btn${over ? ' shader-preview__uniforms-default-btn--active' : ''}`}
          >
            {t('Set as default', language)}{over ? ' (1)' : ''}
          </button>
          <div className="shader-preview__uniform-row">
            <div className="shader-preview__uniform-header">
              <span className="shader-preview__uniform-name">{UNIFORM_NAME}</span>
              <span className={`shader-preview__uniform-value${over ? ' shader-preview__uniform-value--override' : ''}`}>
                {shownValue.toFixed(3)}
              </span>
            </div>
            <div className="shader-preview__uniform-controls">
              <NumberField className="shader-preview__uniform-bound" tabIndex={-1} readOnly value={BOUNDS.min} step={1} text={formatFieldNumber(BOUNDS.min)} onText={noop} />
              <input
                type="range"
                className="shader-preview__uniform-slider"
                tabIndex={-1}
                min={BOUNDS.min}
                max={BOUNDS.max}
                step={step}
                value={shownValue}
                onChange={noop}
              />
              <NumberField className="shader-preview__uniform-bound" tabIndex={-1} readOnly value={BOUNDS.max} step={1} text={formatFieldNumber(BOUNDS.max)} onText={noop} />
              <button
                type="button"
                tabIndex={-1}
                className={`shader-preview__uniform-revert${over ? ' shader-preview__uniform-revert--active' : ''}`}
                disabled={!over}
              >
                ↺
              </button>
            </div>
          </div>
        </div>
      </div>
    </IntroStage>
  );
}
