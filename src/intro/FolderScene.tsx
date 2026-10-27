/**
 * Intro scene — the desktop app's Work folder: pick a folder, open one of its
 * shaders from the list, open another, change a value, Save it back.
 *
 * The toolbar strip is the toolbar's own classes and the Work folder's own
 * pieces (`WorkFolderRow`, `WorkFolderCaretIcon` — shared with WorkFolder.tsx,
 * which itself is desktop-only and never in the web bundle). The folder and
 * its two graphs are an example (folderTour.ts); the name each file gives the
 * shader and which row reads as current are the app's rules. Cards are the
 * tiles' replicas at canvas size; nothing touches the store or the disk.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Position } from '@xyflow/react';
import { useAppStore, DEFAULT_SHADER_NAME } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { t, type Language } from '@/i18n';
import { adoptShaderName, sameShaderFile } from '@/utils/workFolderFile';
import {
  CardSocketLabels,
  NoiseCardContent,
  OutputCardContent,
  ShaderCardContent,
  useCardChrome,
} from '@/components/NodeEditor/NodePreviewCard';
import { WorkFolderCaretIcon, WorkFolderRow } from '@/components/Layout/WorkFolderView';
import {
  EDIT_FROM,
  FOLDER_FILES,
  FOLDER_NAME,
  buildFolderTour,
  folderFrame,
  type FolderDoc,
  type FolderState,
  type FolderTour,
} from './folderTour';
import { IntroStage, centre, paintCursor, stageMeasurer, useIntroStage, type Box } from './IntroStage';
import { IntroWire, edgePortState, sceneNodes, toAppEdges, wirePaths, useWireInk, type SceneEdge } from './sceneGraph';
import type { Point } from './timeline';

const OUTPUT_AT: Point = { x: 336, y: 92 };
const NOISE_AT: Point = { x: 96, y: 104 };
const FLOAT_AT: Point = { x: 150, y: 150 };

const outputDef = NODE_REGISTRY.get('output')!;
const noiseDef = NODE_REGISTRY.get('perlin')!;
const floatDef = NODE_REGISTRY.get('float')!;

/** What each example file holds. */
const WAVES_EDGE: SceneEdge = { source: 'intro-noise', sourceHandle: 'out', target: 'intro-output', targetHandle: 'color' };
const METAL_EDGE: SceneEdge = { source: 'intro-float', sourceHandle: 'out', target: 'intro-output', targetHandle: 'roughness' };

const IDLE: FolderState = { picked: false, list: false, doc: 'none', value: EDIT_FROM, saved: false, pressed: false };

/** The toolbar's centre cluster as the scene shows it — also drawn as an
 *  invisible probe in its LATER states, so every target can be measured
 *  before the pointer heads for it. */
function ToolbarStrip({ state, language, stripRef, probe = false }: {
  state: Pick<FolderState, 'picked' | 'list' | 'doc' | 'saved'>;
  language: Language;
  stripRef?: RefObject<HTMLDivElement>;
  probe?: boolean;
}) {
  const name = state.doc === 'none' ? DEFAULT_SHADER_NAME : adoptShaderName(state.doc, null);
  return (
    <div ref={stripRef} className="toolbar fs-intro__toolbar" style={probe ? { visibility: 'hidden' } : undefined}>
      <div className="toolbar__center">
        <span className="toolbar__name-label">{t('Name:', language)}</span>
        <input className="toolbar__name-input" tabIndex={-1} readOnly value={name} />
        <div className="toolbar__workfolder">
          {state.picked ? (
            <>
              <button
                type="button"
                tabIndex={-1}
                data-intro="save"
                className={`toolbar__sc-link toolbar__wf-save${state.saved ? ' toolbar__wf-save--saved' : ''}`}
              >
                {t('Save', language)}
              </button>
              <button type="button" tabIndex={-1} data-intro="caret" className="toolbar__sc-link toolbar__wf-caret">
                <WorkFolderCaretIcon />
              </button>
            </>
          ) : (
            <button type="button" tabIndex={-1} data-intro="pick" className="toolbar__sc-link toolbar__wf-link">
              {t('Work folder', language)}
            </button>
          )}
          {state.list && (
            <div className="toolbar__local-popover toolbar__wf-popover">
              <div className="toolbar__local-header">
                <span className="toolbar__contact-label">{FOLDER_NAME}</span>
                <span className="toolbar__wf-header-actions">
                  <button type="button" tabIndex={-1} className="toolbar__contact-copy">
                    {t('Open folder', language)}
                  </button>
                  <button type="button" tabIndex={-1} className="toolbar__contact-copy">
                    {t('Change…', language)}
                  </button>
                </span>
              </div>
              {FOLDER_FILES.map((f) => (
                <span key={f.fileName} data-intro-row={f.fileName} style={{ display: 'contents' }}>
                  <WorkFolderRow
                    fileName={f.fileName}
                    sizeBytes={f.sizeBytes}
                    current={state.doc !== 'none' && sameShaderFile(state.doc, f.fileName)}
                    tabIndex={-1}
                  />
                </span>
              ))}
              <button type="button" tabIndex={-1} className="toolbar__wf-forget">
                {t('Forget this folder', language)}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function FolderScene() {
  const stage = useIntroStage();
  const language = useAppStore((s) => s.language);
  const ink = useWireInk();
  const outputChrome = useCardChrome(outputDef);
  const noiseChrome = useCardChrome(noiseDef);
  const floatChrome = useCardChrome(floatDef);

  const stripRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const noiseRef = useRef<HTMLDivElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<number | null>(null);

  const [anchors, setAnchors] = useState<Record<string, Point> | null>(null);
  const [tour, setTour] = useState<FolderTour | null>(null);
  const [state, setState] = useState<FolderState>(IDLE);

  // The wired value each file's Output shows, read on that file's graph.
  const wired = useMemo(() => {
    const nodes = sceneNodes([
      { id: 'intro-noise', def: noiseDef },
      { id: 'intro-float', def: floatDef },
      { id: 'intro-output', def: outputDef },
    ]);
    const float = nodes.find((n) => n.id === 'intro-float')!;
    (float.data as { values: Record<string, number> }).values = { value: state.value };
    return {
      waves: edgePortState(nodes, toAppEdges([WAVES_EDGE]), WAVES_EDGE, { compact: true }).val,
      metal: edgePortState(nodes, toAppEdges([METAL_EDGE]), METAL_EDGE, { compact: true }).val,
    };
  }, [state.value]);

  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const strip = stripRef.current;
    const probe = probeRef.current;
    const outW = outputRef.current;
    const noiseW = noiseRef.current;
    const floatW = floatRef.current;
    if (!stageEl || !strip || !probe || !outW || !noiseW || !floatW) return;
    const measure = () => {
      const box = stageMeasurer(stageEl);
      if (!box) return;
      const base = stageEl.getBoundingClientRect();
      const at0 = { x: 0, y: 0 };
      const inStage = (el: Element | null) => box(el, base, at0);
      const pick = inStage(strip.querySelector('[data-intro="pick"]'));
      const caret = inStage(probe.querySelector('[data-intro="caret"]'));
      const save = inStage(probe.querySelector('[data-intro="save"]'));
      const waves = inStage(probe.querySelector('[data-intro-row="waves.js"] button'));
      const metal = inStage(probe.querySelector('[data-intro-row="metal.js"] button'));
      const value = box(floatW.querySelector('.drag-num__value'), floatW.getBoundingClientRect(), FLOAT_AT);
      const oR = outW.getBoundingClientRect();
      const color = box(outW.querySelector('[data-handleid="color"]'), oR, OUTPUT_AT);
      const rough = box(outW.querySelector('[data-handleid="roughness"]'), oR, OUTPUT_AT);
      const noiseOut = box(noiseW.querySelector('[data-handleid="out"]'), noiseW.getBoundingClientRect(), NOISE_AT);
      const floatOut = box(
        floatW.querySelector('[data-port="out"][data-io="out"]'),
        floatW.getBoundingClientRect(),
        FLOAT_AT,
      );
      const all = [pick, caret, save, waves, metal, value, color, rough, noiseOut, floatOut];
      if (all.some((b) => !b)) return;
      const right = (b: Box) => ({ x: b.x + b.w, y: centre(b).y });
      const left = (b: Box) => ({ x: b.x, y: centre(b).y });
      setAnchors({
        noise: right(noiseOut!),
        float: right(floatOut!),
        color: left(color!),
        roughness: left(rough!),
      });
      setTour(
        buildFolderTour({
          pick: centre(pick!),
          caret: centre(caret!),
          save: centre(save!),
          // The pointer lands on a row a little left of its centre, on the name.
          rows: {
            'waves.js': { x: waves!.x + waves!.w * 0.3, y: centre(waves!).y },
            'metal.js': { x: metal!.x + metal!.w * 0.3, y: centre(metal!).y },
          },
          value: centre(value!),
        }),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [strip, probe, outW, noiseW, floatW]) ro.observe(el);
    return () => ro.disconnect();
  }, [stage.scale, stage.stageRef, language]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    if (!tour || !scene || !cursor) return;
    let shown: FolderState | null = null;
    const paint = (time: number) => {
      const f = folderFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed });
      if (f.state !== shown) {
        shown = f.state;
        setState(f.state);
      }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(tour.saved);
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

  const doc: FolderDoc = state.doc;
  const wire =
    anchors && doc === 'waves.js'
      ? wirePaths(anchors.noise, anchors.color, Position.Right)
      : anchors && doc === 'metal.js'
        ? wirePaths(anchors.float, anchors.roughness, Position.Right)
        : null;
  const show = (on: boolean) => ({ visibility: on ? ('visible' as const) : ('hidden' as const) });

  return (
    <IntroStage stage={stage}>
      <svg className="fs-intro__wires">{wire && <IntroWire ink={ink} d={wire} />}</svg>
      <CardSocketLabels.Provider value={true}>
        <div ref={noiseRef} className="react-flow__node fs-intro__node" style={{ left: NOISE_AT.x, top: NOISE_AT.y, ...show(doc === 'waves.js') }}>
          <NoiseCardContent {...noiseChrome} />
        </div>
        <div ref={floatRef} className="react-flow__node fs-intro__node" style={{ left: FLOAT_AT.x, top: FLOAT_AT.y, ...show(doc === 'metal.js') }}>
          <ShaderCardContent {...floatChrome} values={{ value: state.value }} />
        </div>
        <div ref={outputRef} className="react-flow__node fs-intro__node" style={{ left: OUTPUT_AT.x, top: OUTPUT_AT.y }}>
          <OutputCardContent
            {...outputChrome}
            wired={doc === 'waves.js' ? { color: wired.waves } : doc === 'metal.js' ? { roughness: wired.metal } : undefined}
          />
        </div>
      </CardSocketLabels.Provider>
      <ToolbarStrip state={state} language={language} stripRef={stripRef} />
      <ToolbarStrip state={{ picked: true, list: true, doc: 'none', saved: false }} language={language} stripRef={probeRef} probe />
    </IntroStage>
  );
}
