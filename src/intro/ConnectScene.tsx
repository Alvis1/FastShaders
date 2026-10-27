/**
 * Intro scene 1 — drag a node onto another to connect them.
 *
 * The cards are the asset tiles' replicas (NodePreviewCard's NoiseCardContent
 * and OutputCardContent) at canvas size, so a redesigned node shows up here
 * redesigned. The drag-connect preview is the canvas's own CSS (`.fs-connect-*`
 * in NodeEditor.css and TypedHandle.css), and the socket it rings is picked by
 * the canvas's own planner (connectTour.ts). The wire is drawn by the geometry
 * TypedEdge draws a still wire with.
 *
 * Nothing here touches the store's graph: the cards read only preferences
 * (language, theme, cost colours, the canvas colour). GraphModal's trick —
 * feeding the scene's nodes INTO the store — would let the 300 ms autosave
 * write the intro over the user's work.
 *
 * Motion is a requestAnimationFrame loop for as long as the slide is shown:
 * this is a short foreground animation, not a canvas surface, so it does not
 * ride the 15 Hz decorative ticker (a dragged card at 15 Hz stutters). Each
 * frame writes two transforms and, only when they change, a few classes.
 * Under prefers-reduced-motion it paints one still of the finished connection.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Position } from '@xyflow/react';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import {
  CardSocketLabels,
  NoiseCardContent,
  OutputCardContent,
  useCardChrome,
} from '@/components/NodeEditor/NodePreviewCard';
import type { ConnectHandle } from '@/components/NodeEditor/dragConnect';
import { buildTour, tourFrame, type Tour, type TourGeometry } from './connectTour';
import { IntroStage, centre, paintCursor, stageMeasurer, useIntroStage } from './IntroStage';
import { IntroWire, wirePaths, useWireInk, wiredValueText, type SceneEdge } from './sceneGraph';
import type { Point } from './timeline';

const OUTPUT_ID = 'intro-output';
const NOISE_ID = 'intro-noise';
/** The Output as a user who exposed Emissive sees it (its menu does that) —
 *  a fresh node shows Color, Roughness and Displacement only. */
const OUTPUT_EXPOSED = ['color', 'emissive', 'roughness', 'position'];
/** The sockets the drag visits, bottom to top; the last one is the drop. */
const ROUTE = ['roughness', 'emissive', 'color'];

const OUTPUT_AT: Point = { x: 330, y: 44 };
const NOISE_AT: Point = { x: 44, y: 118 };

const noiseDef = NODE_REGISTRY.get('perlin')!;
const outputDef = NODE_REGISTRY.get('output')!;

/** The wire the drop makes, as the canvas would store it. */
const DROP_EDGE: SceneEdge = { source: NOISE_ID, sourceHandle: 'out', target: OUTPUT_ID, targetHandle: 'color' };

export function ConnectScene() {
  const stage = useIntroStage();
  const outputChrome = useCardChrome(outputDef);
  const noiseChrome = useCardChrome(noiseDef);
  const wiredText = useMemo(
    () => wiredValueText([{ id: NOISE_ID, def: noiseDef }, { id: OUTPUT_ID, def: outputDef }], [DROP_EDGE], DROP_EDGE, { compact: true }),
    [],
  );
  const ink = useWireInk();

  const outputRef = useRef<HTMLDivElement>(null);
  const noiseRef = useRef<HTMLDivElement>(null);
  const wireRef = useRef<SVGPathElement>(null);
  const arrowsRef = useRef<SVGPathElement>(null);
  const socketsRef = useRef(new Map<string, Element>());
  const clockRef = useRef<number | null>(null);

  const [tour, setTour] = useState<Tour | null>(null);
  const [connected, setConnected] = useState(false);

  // Measure the cards as laid out, and again whenever one resizes.
  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const outW = outputRef.current;
    const noiseW = noiseRef.current;
    if (!stageEl || !outW || !noiseW) return;
    const measure = () => {
      const box = stageMeasurer(stageEl);
      if (!box) return;
      const outRect = outW.getBoundingClientRect();
      const noiseRect = noiseW.getBoundingClientRect();
      const target = box(outW.firstElementChild, outRect, OUTPUT_AT);
      const dragged = box(noiseW.firstElementChild, noiseRect, NOISE_AT);
      const outBox = box(noiseW.querySelector('[data-handleid="out"]'), noiseRect, NOISE_AT);
      const header = box(noiseW.querySelector('.node-base__header'), noiseRect, NOISE_AT);
      if (!target || !dragged || !outBox || !header) return;
      const sockets = new Map<string, Element>();
      const targetInputs: ConnectHandle[] = [];
      let targetSocketHalf = 0;
      for (const el of Array.from(outW.querySelectorAll('[data-handleid]'))) {
        const id = el.getAttribute('data-handleid');
        const b = box(el, outRect, OUTPUT_AT);
        if (!id || !b) continue;
        sockets.set(id, el);
        targetInputs.push({ id, ...{ cx: centre(b).x, cy: centre(b).y }, occupied: false });
        targetSocketHalf = b.w / 2;
      }
      socketsRef.current = sockets;
      const geo: TourGeometry = {
        target: { id: OUTPUT_ID, ...target },
        targetInputs,
        targetSocketHalf,
        dragged: { id: NOISE_ID, ...dragged },
        draggedOutput: { id: 'out', cx: centre(outBox).x, cy: centre(outBox).y },
        draggedSocketHalf: outBox.w / 2,
        grab: centre(header),
      };
      setTour(buildTour(geo, ROUTE));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(outW);
    ro.observe(noiseW);
    return () => ro.disconnect();
  }, [stage.scale, stage.stageRef]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    const outW = outputRef.current;
    const noiseW = noiseRef.current;
    const wire = wireRef.current;
    const arrows = arrowsRef.current;
    if (!tour || !scene || !outW || !noiseW || !cursor || !wire || !arrows) return;
    const geo = tour.geo;
    const landing = geo.targetInputs.find((h) => h.id === ROUTE[ROUTE.length - 1]);
    let ringed: Element | null = null;
    let wasConnected: boolean | null = null;

    const paint = (t: number) => {
      const f = tourFrame(tour, t);
      scene.style.opacity = String(f.opacity);
      noiseW.style.transform = `translate(${f.dx}px, ${f.dy}px)`;
      noiseW.classList.toggle('selected', f.selected);
      paintCursor(cursor, f.cursor, { pressed: f.pressed });
      // The drag-connect preview, exactly as NodeEditor's showConnectPreview
      // marks it: ring the hovered node, lift the node owning the socket, ring
      // the socket (whose own label then shows, with the arrow).
      const socket = f.plan ? socketsRef.current.get(f.plan.targetHandle) ?? null : null;
      if (socket !== ringed) {
        ringed?.classList.remove('fs-connect-socket');
        socket?.classList.add('fs-connect-socket');
        outW.classList.toggle('fs-connect-target', socket !== null);
        outW.classList.toggle('fs-connect-front', socket !== null);
        ringed = socket;
      }
      if (f.connected !== wasConnected) {
        wasConnected = f.connected;
        setConnected(f.connected);
      }
      const paths = f.connected && landing
        ? wirePaths(
            { x: geo.draggedOutput.cx + geo.draggedSocketHalf + f.dx, y: geo.draggedOutput.cy + f.dy },
            { x: landing.cx - geo.targetSocketHalf, y: landing.cy },
            Position.Right,
          )
        : { wire: '', arrows: '' };
      wire.setAttribute('d', paths.wire);
      arrows.setAttribute('d', paths.arrows);
    };

    const unmark = () => {
      ringed?.classList.remove('fs-connect-socket');
      outW.classList.remove('fs-connect-target', 'fs-connect-front');
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(tour.still);
      return unmark;
    }
    let raf = 0;
    // ONE clock for the slide's life. The tour is re-planned whenever a card
    // resizes — and selecting the dragged node thickens its frame, so every
    // press does — and restarting the clock there would replay the first two
    // seconds forever. A re-plan only nudges geometry by a pixel or so.
    clockRef.current ??= performance.now();
    const t0 = clockRef.current;
    const loop = (now: number) => {
      paint(now - t0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      unmark();
    };
  }, [tour, stage.sceneRef, stage.cursorRef]);

  return (
    <IntroStage stage={stage}>
      {/* Wires under every node, as on the canvas. */}
      <svg className="fs-intro__wires">
        <IntroWire wireRef={wireRef} arrowsRef={arrowsRef} ink={ink} />
      </svg>
      <CardSocketLabels.Provider value={true}>
        <div ref={outputRef} className="react-flow__node fs-intro__node" style={{ left: OUTPUT_AT.x, top: OUTPUT_AT.y }}>
          <OutputCardContent
            {...outputChrome}
            exposedPorts={OUTPUT_EXPOSED}
            wired={connected ? { color: wiredText } : undefined}
          />
        </div>
        <div ref={noiseRef} className="react-flow__node fs-intro__node" style={{ left: NOISE_AT.x, top: NOISE_AT.y }}>
          <NoiseCardContent {...noiseChrome} />
        </div>
      </CardSocketLabels.Provider>
    </IntroStage>
  );
}
