/**
 * Intro scene — double-click a node (double-tap on touch) to see the names of
 * all its sockets at once: the Image node, whose output sockets carry no text
 * on the card, then Mix, whose input and output sockets are named only by
 * their labels — tapped with a fingertip.
 *
 * The labels are the canvas's own: each socket's `data-tooltip` (TypedHandle's
 * text, carried by the card replicas under `CardSocketLabels`), shown by the
 * same `[data-fs-labels-shown]` attribute NodeEditor puts on a peeked node's
 * wrapper (labelPeek.ts) — so a restyled label is restyled here too. Nothing
 * is written to the store; the picture is the intro's painted photo, small.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Position } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { t } from '@/i18n';
import {
  CardSocketLabels,
  OutputCardContent,
  ShaderCardContent,
  useCardChrome,
} from '@/components/NodeEditor/NodePreviewCard';
import { buildLabelsTour, labelsFrame, type LabelsNode, type LabelsState, type LabelsTour } from './labelsTour';
import { introPhotoThumbnail } from './introPhoto';
import { IntroStage, centre, paintCursor, stageMeasurer, useIntroStage } from './IntroStage';
import { IntroWire, wirePaths, wiredValue, useWireInk, type SceneEdge } from './sceneGraph';
import type { Point } from './timeline';

/** The graph's zoom (kept as a knob: the pointer's places scale by it). */
const ZOOM = 1;
/** Where each card sits, in the graph's own px — far enough apart that
 *  each node's labels clear its neighbour's sockets. */
const AT: Record<string, Point> = {
  image: { x: 6, y: 50 },
  mix: { x: 300, y: 84 },
  output: { x: 412, y: 40 },
};
const REST: Point = { x: 250, y: 262 };

const imageDef = NODE_REGISTRY.get('imageNode')!;
const mixDef = NODE_REGISTRY.get('mix')!;
const outputDef = NODE_REGISTRY.get('output')!;
const SCENE_NODES = [
  { id: 'image', def: imageDef },
  { id: 'mix', def: mixDef },
  { id: 'output', def: outputDef },
];
const EDGES: SceneEdge[] = [
  { source: 'image', sourceHandle: 'out', target: 'mix', targetHandle: 'a' },
  { source: 'mix', sourceHandle: 'out', target: 'output', targetHandle: 'color' },
];

const IDLE: LabelsState = { peek: null, pressed: false, touch: false, cap: null };

/** A socket on a card: a replica's handle (`data-handleid`) or a shader
 *  card's (`data-port`/`data-io`). */
function socketEl(card: Element, handle: string, io: 'in' | 'out'): Element | null {
  const side = io === 'out' ? 'right' : 'left';
  return (
    card.querySelector(`.react-flow__handle-${side}[data-handleid="${CSS.escape(handle)}"]`) ??
    card.querySelector(`[data-port="${CSS.escape(handle)}"][data-io="${io}"]`)
  );
}

export function LabelsScene() {
  const stage = useIntroStage();
  const language = useAppStore((s) => s.language);
  const ink = useWireInk();
  const chrome = {
    image: useCardChrome(imageDef),
    mix: useCardChrome(mixDef),
    output: useCardChrome(outputDef),
  };
  const values = useMemo(() => {
    const url = introPhotoThumbnail();
    return { ...imageDef.defaultValues, ...(url ? { imageB64: url } : {}) } as Record<string, string | number>;
  }, []);
  // What arrives on each wire — its channel count and the value text the
  // input it reaches shows: compact into the Output's FIXED-width value cell,
  // the full form on Mix's growing row.
  const arriving = useMemo(
    () => EDGES.map((e) => wiredValue(SCENE_NODES, EDGES, e, { compact: e.target === 'output' })),
    [],
  );

  const layerRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<number | null>(null);
  const [tour, setTour] = useState<LabelsTour | null>(null);
  const [wires, setWires] = useState<{ a: Point; b: Point }[] | null>(null);
  const [state, setState] = useState<LabelsState>(IDLE);

  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const layer = layerRef.current;
    if (!stageEl || !layer) return;
    const measure = () => {
      const measured = stageMeasurer(stageEl);
      if (!measured) return;
      const base = layer.getBoundingClientRect();
      // In the graph's own px; the pointer's places are scaled back to stage px.
      const box = (el: Element | null) => {
        const b = measured(el, base, { x: 0, y: 0 });
        return b && { x: b.x / ZOOM, y: b.y / ZOOM, w: b.w / ZOOM, h: b.h / ZOOM };
      };
      const card = (id: string) => layer.querySelector(`[data-node="${id}"]`)!;
      const ends: { a: Point; b: Point }[] = [];
      for (const e of EDGES) {
        const a = box(socketEl(card(e.source), e.sourceHandle, 'out'));
        const b = box(socketEl(card(e.target), e.targetHandle, 'in'));
        if (!a || !b) return;
        ends.push({ a: { x: a.x + a.w, y: centre(a).y }, b: { x: b.x, y: centre(b).y } });
      }
      const picture = box(card('image').querySelector('.shader-node__image-thumb') ?? card('image').firstElementChild);
      const header = box(card('mix').querySelector('.node-base__header') ?? card('mix').firstElementChild);
      if (!picture || !header) return;
      const toStage = (p: Point) => ({ x: p.x * ZOOM, y: p.y * ZOOM });
      setWires(ends);
      setTour(buildLabelsTour({ image: toStage(centre(picture)), mix: toStage(centre(header)), rest: REST }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of layer.querySelectorAll('[data-node]')) ro.observe(el);
    return () => ro.disconnect();
  }, [stage.scale, stage.stageRef, language]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    if (!tour || !scene || !cursor) return;
    let shown: LabelsState | null = null;
    const paint = (time: number) => {
      const f = labelsFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed, touch: f.state.touch });
      if (f.state !== shown) {
        shown = f.state;
        setState(f.state);
      }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(tour.mix);
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

  const cap = state.cap === 'click' ? t('Double-click', language) : state.cap === 'tap' ? t('Double-tap', language) : null;
  // NodeEditor's mark on a peeked node's wrapper — an attribute, as there.
  const wrap = (id: string, content: React.ReactNode) => (
    <div
      data-node={id}
      className="react-flow__node fs-intro__node"
      style={{ left: AT[id].x, top: AT[id].y }}
      {...(state.peek === (id as LabelsNode) ? { 'data-fs-labels-shown': '' } : {})}
    >
      {content}
    </div>
  );

  return (
    <IntroStage stage={stage} keyCap={cap}>
      <div ref={layerRef} className="fs-intro__graph" style={{ transform: `scale(${ZOOM})` }}>
        <svg className="fs-intro__wires">
          {wires?.map((w, i) => (
            <IntroWire key={i} ink={ink} count={arriving[i].ch} d={wirePaths(w.a, w.b, Position.Right, 1, arriving[i].ch)} />
          ))}
        </svg>
        <CardSocketLabels.Provider value={true}>
          {wrap('image', <ShaderCardContent {...chrome.image} values={values} />)}
          {wrap('mix', <ShaderCardContent {...chrome.mix} portStates={{ a: arriving[0] }} />)}
          {wrap('output', <OutputCardContent {...chrome.output} wired={{ color: arriving[1].val }} />)}
        </CardSocketLabels.Provider>
      </div>
    </IntroStage>
  );
}
