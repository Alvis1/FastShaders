/**
 * Intro scene 3 — the point budget: the right end of the Gas Giant texture
 * group beside an empty Output, under the cost bar. A wire dragged from the
 * group's last node into Color makes the whole chain count, and the total
 * passes the device's budget.
 *
 * Same rules as the other scenes: the tiles' card replicas at canvas size,
 * nothing written to the store's graph, a requestAnimationFrame loop that
 * moves only the pointer and the dragged connection line. The group is the
 * real built-in texture, loaded when this slide first shows (building it needs
 * the Babel chunk, which must never ride the boot — the intro opens AT boot).
 * The cost bar is the bar's own readout (`CostMeter`) over the user's own
 * device, its two totals are the app's (budgetTour.ts), and they print as the
 * bar prints them: a share of that device's budget, which reads 100 on every
 * device. Its frame draws through GroupNode's own header; the dragged line
 * wears React Flow's connection-line classes, so it looks like the canvas's.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Position } from '@xyflow/react';
import { useAppStore, VR_HEADSETS } from '@/store/useAppStore';
import { useBudgetPoints } from '@/hooks/useDeviceBudget';
import { NODE_REGISTRY, getFlowNodeType } from '@/registry/nodeRegistry';
import { getNodeValues, type AppNode } from '@/types';
import { getGroupFrameColors } from '@/utils/colorUtils';
import { groupFrameSize } from '@/utils/groupFrame';
import {
  CardSocketLabels,
  NoiseCardContent,
  OutputCardContent,
  ShaderCardContent,
  useCardChrome,
} from '@/components/NodeEditor/NodePreviewCard';
import type { PortPreviewState } from '@/components/NodeEditor/nodes/NodeVisual';
import { GroupHeader } from '@/components/NodeEditor/nodes/GroupNode';
import { useCostChrome } from '@/components/NodeEditor/nodes/useCostChrome';
import { CONNECTION_RADIUS } from '@/components/NodeEditor/nodes/connectionReveal';
import { CostMeter, deviceOptionText } from '@/components/Layout/CostBar';
import {
  BUDGET_TEXTURE,
  budgetFrame,
  budgetGraph,
  buildBudgetTour,
  drawnMembers,
  type BudgetAsset,
  type BudgetState,
  type BudgetTour,
} from './budgetTour';
import { IntroStage, STAGE_H, STAGE_W, centre, paintCursor, stageMeasurer, useIntroStage } from './IntroStage';
import { IntroConnectionLine, IntroWire, connectionEnd, connectionPath, edgePortState, wirePaths, useWireInk, type SceneEdge } from './sceneGraph';
import type { Point } from './timeline';

/** The frame's right edge and top, and the Output's top-left, in stage px:
 *  the group's last nodes on the left, the Output right of them under the
 *  cost bar, the way the canvas's top-right corner looks. */
const FRAME_RIGHT = 334;
const FRAME_TOP = 118;
const OUTPUT_AT: Point = { x: 404, y: 132 };

const outputDef = NODE_REGISTRY.get('output')!;
/** The flow types a member card is drawn for; the stage needs no others. */
const DRAWN_TYPES = new Set(['shader', 'preview']);

const IDLE: BudgetState = { dragging: false, connected: false, pressed: false };
const noop = () => {};
const key = (node: string, handle: string) => `${node}\0${handle}`;

interface Anchors {
  out: Map<string, Point>;
  in: Map<string, Point>;
}

/** A socket in a member card: NodeVisual's static handle, or a card socket. */
function socketIn(wrapper: Element, handle: string, io: 'in' | 'out'): Element | null {
  const h = CSS.escape(handle);
  return (
    wrapper.querySelector(`[data-port="${h}"][data-io="${io}"]`) ??
    wrapper.querySelector(`.react-flow__handle-${io === 'out' ? 'right' : 'left'}[data-handleid="${h}"]`)
  );
}

function MemberCard({ node, portStates }: { node: AppNode; portStates?: Record<string, PortPreviewState> }) {
  const def = NODE_REGISTRY.get(node.data.registryType as string)!;
  const chrome = useCardChrome(def);
  return getFlowNodeType(def) === 'preview' ? (
    <NoiseCardContent {...chrome} />
  ) : (
    <ShaderCardContent {...chrome} values={getNodeValues(node)} portStates={portStates} />
  );
}

export function BudgetScene() {
  const stage = useIntroStage();
  const language = useAppStore((s) => s.language);
  const dark = useAppStore((s) => s.codeEditorTheme === 'vs-dark');
  const costLow = useAppStore((s) => s.costColorLow);
  const costHigh = useAppStore((s) => s.costColorHigh);
  const headsetId = useAppStore((s) => s.selectedHeadsetId);
  const costProfiles = useAppStore((s) => s.costProfiles);
  // Bumped when a device change swaps the price table the totals are read with.
  const costVersion = useAppStore((s) => s.costVersion);
  const ink = useWireInk();

  const [asset, setAsset] = useState<BudgetAsset | null>(null);
  useEffect(() => {
    let live = true;
    import('@/registry/builtinTextures')
      .then(({ getBuiltinTextures }) => {
        if (live) setAsset(getBuiltinTextures().find((t) => t.id === BUDGET_TEXTURE) ?? null);
      })
      .catch(() => console.warn('[fs] the built-in texture library failed to load'));
    return () => {
      live = false;
    };
  }, []);

  // Keyed on the device too: the totals read the ACTIVE price table.
  const graph = useMemo(() => (asset ? budgetGraph(asset) : null), [asset, headsetId, costVersion]);
  const frameSize = graph ? groupFrameSize(graph.frame) : { w: 0, h: 0 };
  const frameAt: Point = { x: FRAME_RIGHT - frameSize.w, y: FRAME_TOP };
  const members = useMemo(
    () =>
      graph
        ? drawnMembers(graph, { x: FRAME_RIGHT - groupFrameSize(graph.frame).w, y: FRAME_TOP }, STAGE_W, STAGE_H).filter(
            (n) => {
              const def = NODE_REGISTRY.get(n.data.registryType as string);
              return !!def && DRAWN_TYPES.has(getFlowNodeType(def));
            },
          )
        : [],
    [graph],
  );
  const drawn = useMemo(() => new Set(members.map((n) => n.id)), [members]);
  // What each drawn member's wired inputs show, read on the whole asset.
  const portStates = useMemo(() => {
    const out = new Map<string, Record<string, PortPreviewState>>();
    if (!graph) return out;
    for (const e of graph.edgesAfter) {
      if (!drawn.has(e.target) && e.target !== graph.wire.target) continue;
      const edge: SceneEdge = {
        source: e.source,
        sourceHandle: e.sourceHandle ?? 'out',
        target: e.target,
        targetHandle: e.targetHandle ?? 'in',
      };
      const states = out.get(e.target) ?? {};
      states[edge.targetHandle] = edgePortState(graph.nodesAfter, graph.edgesAfter, edge);
      out.set(e.target, states);
    }
    return out;
  }, [graph, drawn]);

  const outputRef = useRef<HTMLDivElement>(null);
  const costRef = useRef<HTMLDivElement>(null);
  const membersRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<SVGPathElement>(null);
  const clockRef = useRef<number | null>(null);

  const [anchors, setAnchors] = useState<Anchors | null>(null);
  const [tour, setTour] = useState<BudgetTour | null>(null);
  const [state, setState] = useState<BudgetState>(IDLE);

  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const outW = outputRef.current;
    const costEl = costRef.current;
    const holder = membersRef.current;
    if (!graph || !stageEl || !outW || !costEl || !holder) return;
    const measure = () => {
      const box = stageMeasurer(stageEl);
      if (!box) return;
      const next: Anchors = { out: new Map(), in: new Map() };
      for (const el of holder.querySelectorAll<HTMLElement>('[data-member]')) {
        const id = el.dataset.member!;
        const node = members.find((n) => n.id === id);
        if (!node) continue;
        const at = { x: frameAt.x + node.position.x, y: frameAt.y + node.position.y };
        const r = el.getBoundingClientRect();
        for (const e of graph.edgesAfter) {
          if (e.source === id) {
            const handle = e.sourceHandle ?? 'out';
            const b = box(socketIn(el, handle, 'out'), r, at);
            if (b) next.out.set(key(id, handle), { x: b.x + b.w, y: centre(b).y });
          }
          if (e.target === id) {
            const handle = e.targetHandle ?? 'in';
            const b = box(socketIn(el, handle, 'in'), r, at);
            if (b) next.in.set(key(id, handle), { x: b.x, y: centre(b).y });
          }
        }
      }
      const oR = outW.getBoundingClientRect();
      const color = box(outW.querySelector('[data-handleid="color"]'), oR, OUTPUT_AT);
      const total = box(costEl.querySelector('.cost-bar__value'), stageEl.getBoundingClientRect(), { x: 0, y: 0 });
      const from = next.out.get(key(graph.wire.source, graph.wire.sourceHandle));
      if (!color || !total || !from) return;
      const to = { x: color.x, y: centre(color).y };
      next.in.set(key(graph.wire.target, graph.wire.targetHandle), to);
      setAnchors(next);
      // The pointer rests on the number, a little left of its centre.
      setTour(buildBudgetTour({ from, to, total: { x: total.x + total.w * 0.4, y: centre(total).y } }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [outW, costEl, ...holder.querySelectorAll('[data-member]')]) ro.observe(el);
    return () => ro.disconnect();
    // frameAt is derived from graph.
  }, [graph, members, stage.scale, stage.stageRef]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    const line = lineRef.current;
    if (!tour || !scene || !cursor || !line) return;
    let shown: BudgetState | null = null;
    const paint = (time: number) => {
      const f = budgetFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed });
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
      paint(tour.still);
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

  const total = graph ? (state.connected ? graph.after : graph.before) : 0;
  // What the bar prints for that total: its share of the device's budget, 100
  // on every device — divided by the same selected-device budget the bar uses.
  const points = useBudgetPoints(total);
  const outputChrome = useCardChrome(outputDef);
  const outputCost = state.connected && graph ? graph.after : 0;
  const outputCostChrome = useCostChrome(outputCost);
  const device =
    costProfiles.find((p) => p.id === headsetId) ?? VR_HEADSETS.find((h) => h.id === headsetId) ?? VR_HEADSETS[0];

  const wires = anchors && graph
    ? [
        ...graph.edges.filter((e) => drawn.has(e.source) && drawn.has(e.target)),
        ...(state.connected ? [graph.wire] : []),
      ].flatMap((e) => {
        const sh = e.sourceHandle ?? 'out';
        const th = e.targetHandle ?? 'in';
        const a = anchors.out.get(key(e.source, sh));
        const b = anchors.in.get(key(e.target, th));
        if (!a || !b) return [];
        const count = portStates.get(e.target)?.[th]?.ch ?? 1;
        return [{ id: key(e.source, `${sh}\0${e.target}\0${th}`), count, d: wirePaths(a, b, Position.Right, 1, count) }];
      })
    : [];
  const colorState = graph ? portStates.get(graph.wire.target)?.color : undefined;

  return (
    <IntroStage stage={stage}>
      {graph && (
        <div className="fs-intro__frame" style={{ left: frameAt.x, top: frameAt.y, width: frameSize.w, height: frameSize.h }}>
          <div
            className="group-node"
            style={{ ...getGroupFrameColors(graph.frame.data.color as string, false, dark), width: '100%', height: '100%' }}
          >
            <GroupHeader data={graph.frame.data as never} language={language}>
              <span className="group-node__toggle" aria-hidden="true">{'−'}</span>
            </GroupHeader>
          </div>
        </div>
      )}
      <svg className="fs-intro__wires">
        {wires.map((w) => (
          <IntroWire key={w.id} ink={ink} count={w.count} d={w.d} />
        ))}
      </svg>
      <CardSocketLabels.Provider value={true}>
        <div ref={membersRef}>
          {members.map((n) => (
            <div
              key={n.id}
              data-member={n.id}
              className="react-flow__node fs-intro__node"
              style={{ left: frameAt.x + n.position.x, top: frameAt.y + n.position.y }}
            >
              <MemberCard node={n} portStates={portStates.get(n.id)} />
            </div>
          ))}
        </div>
        <div ref={outputRef} className="react-flow__node fs-intro__node" style={{ left: OUTPUT_AT.x, top: OUTPUT_AT.y }}>
          <OutputCardContent
            {...outputChrome}
            {...outputCostChrome}
            cost={outputCost}
            wired={state.connected && colorState ? { color: colorState.val } : undefined}
          />
        </div>
      </CardSocketLabels.Provider>
      {/* The connection being dragged: React Flow's own line classes. */}
      <IntroConnectionLine lineRef={lineRef} />
      {/* The cost bar, where the canvas has it: its device row and readout. */}
      <div ref={costRef} className="node-editor__cost-overlay">
        <div className="cost-bar">
          <div className="cost-bar__device-row">
            <select className="cost-bar__headset-select" tabIndex={-1} value={device.id} onChange={noop}>
              <option value={device.id}>{deviceOptionText(device)}</option>
            </select>
          </div>
          <CostMeter
            points={points}
            language={language}
            colorLow={costLow}
            colorHigh={costHigh}
            lowPole={<span className="palette-swatch cost-bar__pole-picker" style={{ background: costLow }} />}
            highPole={<span className="palette-swatch cost-bar__pole-picker" style={{ background: costHigh }} />}
          />
        </div>
      </div>
    </IntroStage>
  );
}
