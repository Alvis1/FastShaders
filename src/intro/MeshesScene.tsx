/**
 * Intro scene — one model, several meshes, several Outputs: the first Output
 * shades the whole model; the second's mesh list is opened and two meshes are
 * ticked, and on the 3D view exactly those two take its colour.
 *
 * All real where it matters: the view is the preview document (IntroPreview)
 * fed the model's bytes as a drop feeds them; the shader is `graphToCode` of
 * the canvas's own graph shape (meshesTour's `meshesGraph` — a targeted Output
 * carries `meshTargets`, emitted as `parts`), hot-swapped at each tick; and
 * the list's names are the ones that document REPORTS for the model, so the
 * slide can only tick a mesh the app would offer. The cards are the tiles'
 * replicas; the picker and its list are MeshTargetPicker's own classes,
 * drawn inert (the real one portals to the body and edits the store).
 *
 * The model is fetched when this slide first shows, never with the intro.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Position } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { graphToCode } from '@/engine/graphToCode';
import { buildPreviewShaderModule } from '@/engine/tslToPreviewHTML';
import { t } from '@/i18n';
import { getNodeValues } from '@/types';
import {
  CardSocketLabels,
  ColorCardContent,
  OutputCardContent,
  ShaderCardContent,
  useCardChrome,
} from '@/components/NodeEditor/NodePreviewCard';
import { IntroPreview } from './IntroPreview';
import {
  MESHES_COLOR,
  MESHES_EDGES,
  MESHES_MODEL,
  MESHES_FIELD,
  MESHES_OUT_ALL,
  MESHES_OUT_PART,
  buildMeshesTour,
  meshPicks,
  meshesFrame,
  meshesGraph,
  targetsAfter,
  type MeshesState,
  type MeshesTour,
} from './meshesTour';
import { placePopover } from '@/components/inputs/colorPickerModel';
import { IntroStage, STAGE_H, STAGE_W, centre, paintCursor, stageMeasurer, useIntroStage } from './IntroStage';
import { IntroWire, useWireInk, wiredValue, wirePaths } from './sceneGraph';
import type { Point } from './timeline';

const PANE = { x: 318, y: 12, w: 230, h: 276 };
const FIELD_AT: Point = { x: 40, y: 40 };
const OUT_ALL_AT: Point = { x: 168, y: 22 };
const COLOR_AT: Point = { x: 46, y: 182 };
const OUT_PART_AT: Point = { x: 168, y: 164 };
/** Where a click on empty canvas closes the list. */
const AWAY: Point = { x: 80, y: 140 };
/** Rows of the list shown: the list is height-capped, as the real one is. */
const LIST_ROWS = 6;
const SHOWN = ['color'] as const;

const fieldDef = NODE_REGISTRY.get('normalLocal')!;
const colorDef = NODE_REGISTRY.get('color')!;
const outputDef = NODE_REGISTRY.get('output')!;

let loading: Promise<Uint8Array | null> | null = null;
function loadModel(): Promise<Uint8Array | null> {
  loading ??= fetch(`${import.meta.env.BASE_URL}${MESHES_MODEL.path}`)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
    .then((b) => new Uint8Array(b))
    .catch(() => null);
  return loading;
}

const SCENE_NODES = [
  { id: MESHES_FIELD, def: fieldDef },
  { id: MESHES_COLOR, def: colorDef },
  { id: MESHES_OUT_ALL, def: outputDef },
  { id: MESHES_OUT_PART, def: outputDef },
];
/** The value text each Output's Color cell shows, from the scene's own graph. */
const arriving = (target: string) => {
  const e = MESHES_EDGES.find((x) => x.target === target)!;
  return { color: wiredValue(SCENE_NODES, MESHES_EDGES, e, { compact: true }).val };
};

/** The colour a fresh Color node really carries (the scene graph's own value). */
const COLOR_HEX = (() => {
  const node = meshesGraph([]).nodes.find((n) => n.id === MESHES_COLOR);
  const hex = node ? getNodeValues(node).hex : undefined;
  return typeof hex === 'string' ? hex : undefined;
})();

const IDLE: MeshesState = { open: false, ticked: 0, pressed: false };

/** The closed picker, inert: MeshTargetPicker's button markup. */
function PickerButton({ label, more, parked }: { label: string; more: boolean; parked?: boolean }) {
  return (
    <span className={`mesh-picker${parked ? ' mesh-picker--parked' : ''}`} data-intro-picker>
      <span className="mesh-picker__label">{label}</span>
      {more && <span className="mesh-picker__more">{'…'}</span>}
      <span className="mesh-picker__caret" aria-hidden="true" />
    </span>
  );
}

export function MeshesScene() {
  const stage = useIntroStage();
  const language = useAppStore((s) => s.language);
  const fieldChrome = useCardChrome(fieldDef);
  const colorChrome = useCardChrome(colorDef);
  const outChrome = useCardChrome(outputDef);
  const ink = useWireInk();

  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadModel().then((b) => {
      if (live) setBytes(b);
    });
    return () => {
      live = false;
    };
  }, []);

  // Every fresh document re-reports; keep the array while the names are the same.
  const onMeshes = (next: string[]) =>
    setNames((prev) => (prev && prev.join('\0') === next.join('\0') ? prev : next));
  const picks = useMemo(() => (names ? meshPicks(names) : null), [names]);
  // The module per tick count. Nothing ticked needs no names, so the view
  // boots on it while the document is still reporting its meshes.
  const shaders = useMemo(() => {
    const counts = picks ? [0, 1, 2] : [0];
    return counts.map((n) => {
      const g = meshesGraph(names && picks ? targetsAfter(names, picks, n) : []);
      const tsl = graphToCode(g.nodes, g.edges).code;
      return { tsl, module: buildPreviewShaderModule(tsl) };
    });
  }, [names, picks]);

  const fieldRef = useRef<HTMLDivElement>(null);
  const colorRef = useRef<HTMLDivElement>(null);
  const outAllRef = useRef<HTMLDivElement>(null);
  const outPartRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<number | null>(null);
  const [wires, setWires] = useState<{ id: string; d: ReturnType<typeof wirePaths> }[]>([]);
  const [listAt, setListAt] = useState<Point>({ x: 0, y: 0 });
  const [tour, setTour] = useState<MeshesTour | null>(null);
  const [state, setState] = useState<MeshesState>(IDLE);

  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const els = [fieldRef.current, colorRef.current, outAllRef.current, outPartRef.current, listRef.current];
    if (!stageEl || els.some((e) => !e)) return;
    const [fieldW, colorW, allW, partW, list] = els as HTMLDivElement[];
    const measure = () => {
      const box = stageMeasurer(stageEl);
      if (!box) return;
      const nR = fieldW.getBoundingClientRect();
      const cR = colorW.getBoundingClientRect();
      const aR = allW.getBoundingClientRect();
      const pR = partW.getBoundingClientRect();
      const nOut = box(fieldW.querySelector('[data-port="out"][data-io="out"]'), nR, FIELD_AT);
      const cOut = box(colorW.querySelector('.react-flow__handle-right'), cR, COLOR_AT);
      const aIn = box(allW.querySelector('[data-handleid="color"]'), aR, OUT_ALL_AT);
      const pIn = box(partW.querySelector('[data-handleid="color"]'), pR, OUT_PART_AT);
      const picker = box(partW.querySelector('[data-intro-picker]'), pR, OUT_PART_AT);
      if (!nOut || !cOut || !aIn || !pIn || !picker) return;
      const pair = (a: typeof nOut, b: typeof aIn, id: string) => ({
        id,
        d: wirePaths({ x: a.x + a.w, y: centre(a).y }, { x: b.x, y: centre(b).y }, Position.Right, 1),
      });
      setWires([pair(nOut, aIn, 'normal'), pair(cOut, pIn, 'color')]);
      // The list opens where placePopover puts it — under the picker, or
      // above it when the stage (the viewport here) has no room below.
      const lR = list.getBoundingClientRect();
      const size = box(list, lR, { x: 0, y: 0 });
      if (!size) return;
      const placed = placePopover(
        { left: picker.x, top: picker.y, bottom: picker.y + picker.h },
        { width: size.w, height: size.h },
        { width: STAGE_W, height: STAGE_H },
      );
      const at = { x: placed.left, y: placed.top };
      setListAt(at);
      if (!picks) return;
      const row = (name: string) => box(list.querySelector(`[data-intro-mesh="${CSS.escape(name)}"]`), lR, at);
      const r0 = row(picks[0]);
      const r1 = row(picks[1]);
      if (!r0 || !r1) return;
      // The pointer lands on each row's checkbox.
      const onBox = (r: NonNullable<typeof r0>): Point => ({ x: r.x + 12, y: centre(r).y });
      setTour(buildMeshesTour({ picker: centre(picker), rows: [onBox(r0), onBox(r1)], away: AWAY }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of els) ro.observe(el!);
    return () => ro.disconnect();
  }, [stage.scale, stage.stageRef, picks, bytes]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    if (!scene || !cursor) return;
    if (!tour) {
      // Until the model has reported its meshes there is nothing to tick:
      // the scene shows, the pointer rests.
      scene.style.opacity = '1';
      paintCursor(cursor, { x: 40, y: 260 }, {});
      return;
    }
    let shown: MeshesState | null = null;
    const paint = (time: number) => {
      const f = meshesFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed });
      if (f.state !== shown) {
        shown = f.state;
        setState(f.state);
      }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(tour.after);
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

  const model = useMemo(() => (bytes ? { id: 1, bytes } : null), [bytes]);
  const shader = shaders[Math.min(state.ticked, shaders.length - 1)];
  const targets = names && picks ? targetsAfter(names, picks, state.ticked) : [];
  const listNames = (names ?? []).slice(0, Math.max(LIST_ROWS, names && picks ? Math.max(...picks.map((p) => names.indexOf(p))) + 1 : 0));

  return (
    <IntroStage stage={stage}>
      <svg className="fs-intro__wires">
        {wires.map((w) => (
          <IntroWire key={w.id} ink={ink} boost={1} d={w.d} />
        ))}
      </svg>
      <CardSocketLabels.Provider value={true}>
        <div ref={fieldRef} className="react-flow__node fs-intro__node" style={{ left: FIELD_AT.x, top: FIELD_AT.y }}>
          <ShaderCardContent {...fieldChrome} />
        </div>
        <div ref={colorRef} className="react-flow__node fs-intro__node" style={{ left: COLOR_AT.x, top: COLOR_AT.y }}>
          <ColorCardContent def={colorDef} cost={colorChrome.cost} costTextColor={colorChrome.costTextColor} hex={COLOR_HEX} />
        </div>
        <div ref={outAllRef} className="react-flow__node fs-intro__node" style={{ left: OUT_ALL_AT.x, top: OUT_ALL_AT.y }}>
          <OutputCardContent
            {...outChrome}
            exposedPorts={SHOWN}
            ordinal="_01"
            wired={arriving(MESHES_OUT_ALL)}
            meshRow={<PickerButton label={t('All meshes', language)} more={false} />}
          />
        </div>
        <div ref={outPartRef} className="react-flow__node fs-intro__node" style={{ left: OUT_PART_AT.x, top: OUT_PART_AT.y }}>
          <OutputCardContent
            {...outChrome}
            exposedPorts={SHOWN}
            ordinal="_02"
            wired={arriving(MESHES_OUT_PART)}
            meshRow={
              targets.length
                ? <PickerButton label={targets[0]} more={targets.length > 1} />
                : <PickerButton label={t('Not rendered', language)} more={false} parked />
            }
          />
        </div>
      </CardSocketLabels.Provider>

      {/* The mesh list (MeshTargetPicker's popover), height-capped. */}
      <div
        ref={listRef}
        className="mesh-picker__pop fs-intro__mesh-list"
        style={{ left: listAt.x, top: listAt.y, visibility: state.open ? 'visible' : 'hidden' }}
      >
        <label className="mesh-picker__row mesh-picker__row--default">
          <input type="checkbox" tabIndex={-1} readOnly checked={targets.length === 0} />
          <span className="mesh-picker__name">{t('All meshes (default)', language)}</span>
        </label>
        {listNames.map((name) => (
          <label key={name} className="mesh-picker__row" data-intro-mesh={name}>
            <input type="checkbox" tabIndex={-1} readOnly checked={targets.includes(name)} />
            <span className="mesh-picker__name">{name}</span>
          </label>
        ))}
      </div>

      {model && (
        <div className="fs-intro__pane" style={{ left: PANE.x, top: PANE.y, width: PANE.w, height: PANE.h }}>
          <IntroPreview tslCode={shader.tsl} module={shader.module} model={model} zoom={1.3} onMeshes={onMeshes} />
        </div>
      )}
    </IntroStage>
  );
}
