/**
 * Intro scene — your own models: Rodin's Thinker, then an animated figure,
 * dragged onto the 3D view, each shaded by the same graph — the Vertex Wave
 * preset moving the surface and Checker colouring it, its dark squares in
 * Iron — each model with its own numbers (modelTour's `ShaderTune`).
 *
 * All real: the view is the preview document (IntroPreview) fed each model's
 * bytes as a drop feeds them; the shader is `graphToCode` of the two built-in
 * presets wired into one Output (modelTour's `combinePresets`); and whether a
 * drop ASKS "Only Mesh / Mesh with Materials" is the app's own decision —
 * `readGltfModel` → `glbImportFactsOf` → `planGlbImportDialog` on the file's
 * bytes, worded by `glbDialogCopy` and drawn by the dialog's own panel. The
 * slide answers Only Mesh, which keeps the graph's shader on the model.
 *
 * The presets need the Babel chunk and the models are 2.3 MB between them, so
 * both are fetched when this slide first shows, never with the intro.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppStore, resolveDeviceTextureDim } from '@/store/useAppStore';
import { graphToCode } from '@/engine/graphToCode';
import { buildPreviewShaderModule } from '@/engine/tslToPreviewHTML';
import { readGltfModel } from '@/utils/gltfReader';
import { glbImportFactsOf, planGlbImportDialog } from '@/utils/glbImportGate';
import { glbDialogCopy } from '@/utils/glbImportCopy';
import { formatKbMb } from '@/utils/formatSize';
import { GlbImportPanel } from '@/components/Modals/GlbImportModal';
import { IntroPreview } from './IntroPreview';
import {
  COLOR_PRESET,
  INTRO_MODELS,
  SPHERE_TUNE,
  WAVE_PRESET,
  buildModelTour,
  combinePresets,
  modelFrame,
  type IntroModelKey,
  type ModelState,
  type ModelTour,
} from './modelTour';
import { IntroStage, centre, paintCursor, stageMeasurer, useIntroStage } from './IntroStage';
import type { Point } from './timeline';

const PANE = { x: 12, y: 12, w: 536, h: 276 };
/** The two models read 1.5× the pane's own framing (owner, 2026-10-18); the
 *  sphere keeps the pane's. */
const MODEL_ZOOM = 1.5;
const ENTER: Point = { x: -40, y: 236 };
const GRIP: Point = { x: 18, y: 14 };
const noop = () => {};

interface Loaded {
  /** The graph's code and module per model (each with its own numbers), and
   *  for the sphere the view starts on. */
  shaders: Record<IntroModelKey | 'sphere', { tsl: string; module: string }>;
  bytes: Record<IntroModelKey, Uint8Array>;
}

let loading: Promise<Loaded | null> | null = null;

async function load(): Promise<Loaded | null> {
  const base = import.meta.env.BASE_URL;
  const [{ getBuiltinPresets }, ...files] = await Promise.all([
    import('@/registry/builtinPresets'),
    ...INTRO_MODELS.map((m) =>
      fetch(`${base}${m.path}`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))),
    ),
  ]);
  const presets = getBuiltinPresets();
  const wave = presets.find((p) => p.id === WAVE_PRESET);
  const field = presets.find((p) => p.id === COLOR_PRESET);
  if (!wave || !field) return null;
  const shaders = {} as Loaded['shaders'];
  for (const { key, tune } of [...INTRO_MODELS, { key: 'sphere' as const, tune: SPHERE_TUNE }]) {
    const graph = combinePresets(wave, field, tune);
    const tsl = graphToCode(graph.nodes, graph.edges).code;
    shaders[key] = { tsl, module: buildPreviewShaderModule(tsl) };
  }
  const bytes = Object.fromEntries(INTRO_MODELS.map((m, i) => [m.key, new Uint8Array(files[i])])) as Record<IntroModelKey, Uint8Array>;
  return { shaders, bytes };
}

const IDLE: ModelState = { shown: 'sphere', dragging: null, ask: null, pressed: false };

export function ModelScene() {
  const stage = useIntroStage();
  const language = useAppStore((s) => s.language);
  const allowManyMaterials = useAppStore((s) => s.allowManyMaterials);
  const ignoreImageLimits = useAppStore((s) => s.ignoreImageLimits);
  const deviceMaxDim = useAppStore((s) => resolveDeviceTextureDim(s.selectedHeadsetId, s.costProfiles));

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    loading ??= load().catch(() => null);
    void loading.then((l) => {
      if (live) setLoaded(l);
    });
    return () => {
      live = false;
    };
  }, []);

  // What a drop of each file would ask — the app's own plan and words.
  const asks = useMemo(() => {
    const out: Partial<Record<IntroModelKey, ReturnType<typeof glbDialogCopy>>> = {};
    if (!loaded) return out;
    INTRO_MODELS.forEach(({ key, fileName }, i) => {
      const bytes = loaded.bytes[key];
      const read = readGltfModel(bytes, 'glb');
      const facts = read.ok ? glbImportFactsOf(read.model, fileName, bytes.length) : null;
      const plan = planGlbImportDialog(facts, { allowManyMaterials, ignoreImageLimits, deviceMaxDim });
      // The first drop lands on the sphere; the second replaces a model.
      if (plan.offer) out[key] = glbDialogCopy(plan, facts, { hasModel: i > 0, phase: 'ask', progress: null, fileName }, language);
    });
    return out;
  }, [loaded, allowManyMaterials, ignoreImageLimits, deviceMaxDim, language]);

  const askRefs = useRef<Partial<Record<IntroModelKey, HTMLDivElement | null>>>({});
  const chipRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<number | null>(null);
  const [tour, setTour] = useState<ModelTour | null>(null);
  const [state, setState] = useState<ModelState>(IDLE);

  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    if (!loaded || !stageEl) return;
    const measure = () => {
      const box = stageMeasurer(stageEl);
      if (!box) return;
      const base = stageEl.getBoundingClientRect();
      const onlyMesh = {} as Record<IntroModelKey, Point | null>;
      for (const { key } of INTRO_MODELS) {
        const panel = askRefs.current[key];
        const btn = panel ? box(panel.querySelector('.csv-import-modal__choice'), base, { x: 0, y: 0 }) : null;
        onlyMesh[key] = btn ? centre(btn) : null;
      }
      setTour(buildModelTour({ enter: ENTER, drop: { x: PANE.x + PANE.w / 2, y: PANE.y + PANE.h / 2 }, onlyMesh }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of Object.values(askRefs.current)) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [loaded, asks, stage.scale, stage.stageRef]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    const chip = chipRef.current;
    if (!tour || !scene || !cursor || !chip) return;
    let shown: ModelState | null = null;
    const paint = (time: number) => {
      const f = modelFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed });
      chip.style.transform = `translate(${f.cursor.x - GRIP.x}px, ${f.cursor.y - GRIP.y}px)`;
      chip.style.visibility = f.state.dragging ? 'visible' : 'hidden';
      if (f.state !== shown) {
        shown = f.state;
        setState(f.state);
      }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(tour.figure);
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

  const model = useMemo(() => {
    if (!loaded || state.shown === 'sphere') return null;
    const i = INTRO_MODELS.findIndex((m) => m.key === state.shown);
    return { id: i + 1, bytes: loaded.bytes[state.shown] };
  }, [loaded, state.shown]);
  const shader = loaded ? loaded.shaders[state.shown] : null;
  const dragged = INTRO_MODELS.find((m) => m.key === state.dragging) ?? INTRO_MODELS[0];

  return (
    <IntroStage stage={stage}>
      {loaded && shader && (
        <>
          <div className="fs-intro__pane" style={{ left: PANE.x, top: PANE.y, width: PANE.w, height: PANE.h }}>
            <IntroPreview tslCode={shader.tsl} module={shader.module} model={model} zoom={model ? MODEL_ZOOM : 1} />
          </div>

          {/* The file as the operating system drags it in. */}
          <div ref={chipRef} className="fs-intro__file" style={{ visibility: 'hidden' }}>
            <svg className="fs-intro__file-thumb" viewBox="0 0 48 36" aria-hidden="true">
              <path d="M24 5 L38 12 L38 26 L24 33 L10 26 L10 12 Z M10 12 L24 19 L38 12 M24 19 L24 33" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            </svg>
            <div>
              <div className="fs-intro__file-name">{dragged.fileName}</div>
              <div className="fs-intro__file-meta">{formatKbMb(loaded.bytes[dragged.key].length)}</div>
            </div>
          </div>

          {INTRO_MODELS.map(({ key }) => {
            const copy = asks[key];
            if (!copy) return null;
            return (
              <div
                key={key}
                ref={(el) => {
                  askRefs.current[key] = el;
                }}
                className="csv-import-modal__backdrop fs-intro__backdrop"
                style={{ visibility: state.ask === key ? 'visible' : 'hidden' }}
              >
                <GlbImportPanel copy={copy} building={false} busy={false} onChoose={noop} inert />
              </div>
            );
          })}
        </>
      )}
    </IntroStage>
  );
}
