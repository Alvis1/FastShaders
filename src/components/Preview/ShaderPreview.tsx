import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findDefaultOutput } from '@/utils/outputMaterials';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { ScrollArrow, useScrollArrows } from '@/components/Layout/ScrollArrows';
import { evalLog } from '@/eval/telemetry';
import { getNodeValues } from '@/types';
import type { AppNode, AppEdge } from '@/types';
import { usePersistedState } from '@/hooks/usePersistedState';
import {
  GEOMETRY_ROTATIONS,
  LIGHT_PRESETS,
  buildGeoAttr,
  getModelUrl,
  isModelGeometry,
  tslToPreviewHTML,
} from '@/engine/tslToPreviewHTML';
import type { CameraPosition, GeometryType, LightingMode, PreviewOptions } from '@/engine/tslToPreviewHTML';
import { createPreviewMesh, detectMeshKind, MESH_MAX_BYTES } from '@/utils/previewMesh';
import { sanitizeMeshInventory } from '@/utils/meshInventory';
import { MESH_HIGHLIGHT_EVENT, type MeshHighlightDetail } from '@/utils/meshHighlight';
import { bootGeometryWasCustom, loadPreviewMeshFromCache } from '@/utils/previewMeshCache';
import { connectedUniformNamesKey, ALL_UNIFORMS } from '@/utils/connectedUniforms';
import { evaluateEdgeSource, getTargetEdges } from '@/engine/cpuEvaluator';
import {
  isLiveAudioUniformName,
  liveAudioVarBaseOf,
  MIC_VAR_BASE,
  AUDIO_VAR_BASE,
} from '@/utils/micAnalysis';
import { readMicSettings } from '@/utils/micNode';
import { useMicPump } from './useMicPump';
import { MicControl } from './MicControl';
import { applyUniformDefaults, planUniformDefaults } from '@/utils/uniformDefaults';
import { safeJsonReviver } from '@/utils/safeJson';
import { graphToCode } from '@/engine/graphToCode';
import { inlineImageAssetsFromNodes } from '@/engine/imageAssets';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { importShaderText, importShaderZip, isZipFile } from '@/engine/projectImport';
import { displayImageFileName } from '@/utils/imageNode';
import { platformWebGL2Reason } from '@/utils/feedbackReport';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import { AnimClipMenu } from './AnimClipMenu';
import { useLongPress } from '@/hooks/useLongPress';
import {
  extractUniforms, isOverridden, overriddenUniforms,
  clearUniformValue, clearUniformValues, seedBounds, fallbackBounds,
  sanitizeUniformValues, sanitizeUniformBounds,
  type UniformInfo, type UniformBounds,
} from '@/utils/uniformOverride';
import './ShaderPreview.css';

// The uniform-value rules live in a pure module so they are node-testable:
// this file has no test coverage (the vitest env is `node`, no jsdom), and the
// precedence between a tuned preview value and the graph's authored number is
// exactly the kind of thing that must not be decided in an untested .tsx.
/** Safari still exposes fullscreen only under the webkit-prefixed names. */
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

/**
 * Number input that buffers in-progress text as a string so the user can type
 * partial values like "-" or "1e" without the controlled-input round-trip
 * snapping the field back to the previous numeric value. Commits on every
 * successful parse and re-syncs from the prop on blur or when the prop changes
 * outside of editing.
 */
function BoundInput({
  value,
  onCommit,
  title,
  className,
}: {
  value: number;
  onCommit: (n: number) => void;
  title: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const editingRef = useRef(false);
  useEffect(() => {
    if (!editingRef.current) setDraft(String(value));
  }, [value]);
  return (
    <input
      type="number"
      className={className}
      value={draft}
      step="any"
      title={title}
      onFocus={() => { editingRef.current = true; }}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = parseFloat(e.target.value);
        if (!isNaN(n)) onCommit(n);
      }}
      onBlur={() => {
        editingRef.current = false;
        const n = parseFloat(draft);
        if (isNaN(n)) setDraft(String(value));
        else setDraft(String(n));
      }}
    />
  );
}

function validateGeometry(v: string | null): GeometryType {
  if (v === 'cube' || v === 'plane' || v === 'sphere' || v === 'teapot' || v === 'bunny') return v;
  // 'custom' is only valid while a mesh is actually loaded. The store is read
  // IMPERATIVELY on purpose: this validator must keep a stable module-scope
  // identity (usePersistedState requirement), yet still see a mesh that a
  // project import committed synchronously right before dispatching the
  // fs:project-imported re-read. On a fresh boot previewMesh is always null
  // (never persisted), so a stale persisted 'custom' degrades to sphere.
  if (v === 'custom' && useAppStore.getState().previewMesh) return 'custom';
  return 'sphere';
}

/** Middle-ellipsis so a long dropped-file name can't blow out the controls bar. */
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}

function validateLighting(v: string | null): LightingMode {
  // 'env' is only honoured while an env map is actually wired — the
  // effLighting derivation in the component falls back to studio otherwise,
  // so a persisted 'env' can't boot into a lightless void.
  if (v === 'studio' || v === 'moon' || v === 'laboratory' || v === 'env') return v;
  return 'studio';
}

// bgColor is concatenated into the preview iframe HTML (`background="color:
// ${bgColor}"`). An imported project file controls it via fs:previewBgColor,
// so — like geometry/lighting above — it must be validated before use or a
// payload like `red"></a-scene><img src=x onerror=…>` would inject markup.
// Accept only hex, rgb()/rgba() with numeric content, or a bare CSS color
// keyword (letters only — no spaces/quotes/brackets to break out with).
const DEFAULT_BG_COLOR = '#808080';

/**
 * Whether AUTO mode can only ever yield WebGL2 here — derived from
 * PARENT-observable facts (no `navigator.gpu`, or the platform rule shared
 * with the feedback report), NEVER from the iframe's `fs:backend` report:
 * that report comes from the sandboxed document, which runs the loaded
 * shader (adversarial by project rule) and could forge it to pin the
 * WGSL/GLSL toggle inert with a false "WebGPU is not available" tooltip —
 * disabling exactly the diagnostic a user would reach for on a suspicious
 * shader. The report drives the button's LABEL only, the same display-only
 * trust `fs:anim` gets. Module-scope: none of these inputs change within a
 * session. (The one case the parent can't see — gpu exposed but the
 * pre-flight's adapter request failing — degrades to an unlocked toggle
 * whose "force" click is a harmless no-op, which is honest UX rather than
 * a forgeable lock.)
 */
const AUTO_IS_WEBGL2 = typeof navigator !== 'undefined'
  && (!('gpu' in navigator)
    || platformWebGL2Reason(
      navigator.userAgent || '',
      navigator.platform || '',
      navigator.maxTouchPoints || 0,
    ) !== null);
function isValidCssColor(v: string): boolean {
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ||
    /^rgba?\(\s*[\d.,\s%]+\)$/.test(v) ||
    /^[a-zA-Z]{3,20}$/.test(v);
}
function validateBgColor(v: string | null): string {
  if (v && isValidCssColor(v)) return v;
  return DEFAULT_BG_COLOR;
}

const SUBDIVISION_MIN = 1;
const SUBDIVISION_MAX = 256;
const SUBDIVISION_DEFAULT = 64;

/**
 * How long the generated TSL must hold still before the preview iframe is
 * rebuilt. Long enough to swallow a pointermove stream from a value scrub,
 * short enough to still feel like live editing on a deliberate edit.
 */
const PREVIEW_REBUILD_DEBOUNCE_MS = 200;

/** Failsafe: never leave the "Compiling…" overlay up longer than this. */
const COMPILE_OVERLAY_TIMEOUT_MS = 12000;

/**
 * Trailing-debounce a value: the first value is adopted immediately (so initial
 * paint isn't delayed) and each subsequent change waits for `delayMs` of quiet.
 */
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const id = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(id);
  }, [value, settled, delayMs]);
  return settled;
}

function validateSubdivision(raw: string | null): number {
  const v = parseInt(raw ?? '', 10);
  if (!isNaN(v) && v >= SUBDIVISION_MIN && v <= SUBDIVISION_MAX) return v;
  return SUBDIVISION_DEFAULT;
}

function loadVec3(key: string, reject?: (p: CameraPosition) => boolean): CameraPosition | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const p = JSON.parse(raw, safeJsonReviver);
      if (p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') {
        if (reject?.(p)) {
          try { localStorage.removeItem(key); } catch { /* */ }
          return null;
        }
        return { x: p.x, y: p.y, z: p.z };
      }
    }
  } catch { /* */ }
  return null;
}

function loadCameraPos(): CameraPosition | null {
  // Reject origin-ish values — a prior bug saved (0,0,0) every frame by
  // reading the camera-entity wrapper instead of the camera itself.
  // Restoring that would place the camera inside the mesh.
  return loadVec3('fs:previewCameraPos', (p) => Math.hypot(p.x, p.y, p.z) < 1);
}

function loadRotation(): CameraPosition | null {
  return loadVec3('fs:previewRotation');
}

function validatePlaying(v: string | null): boolean {
  return v === 'true';
}

/** FPS/frame-time readout — off by default, like podest's own. */
function validateStats(v: string | null): boolean {
  return v === 'true';
}

/**
 * What the iframe's `gltf-anim` component reports about the loaded model. Null
 * whenever the current preview has no playable clip — a primitive, an OBJ, or a
 * glTF that ships geometry only — which is also what hides the whole animation
 * cluster and its timeline.
 */
interface AnimInfo {
  /** Clip length in seconds. Always > 0 — a zero-length clip reports has:false. */
  duration: number;
  /**
   * Whether the clip HAS root translation to remove. A spinning turbine or a
   * morph-only blink has none, so the in-place toggle is disabled rather than
   * left as a button that silently does nothing.
   */
  canInPlace: boolean;
  name: string;
  /** Index of the clip currently playing, within `clips`. */
  clip: number;
  /** Every clip in the file. Picked from the play button's context menu. */
  clips: string[];
}

// Animation playback defaults to ON: a dropped model that carries an animation
// and then sits perfectly still reads as the file being broken, not as the
// preview being paused. In-place defaults to OFF — the authored motion is what
// the file says, and pinning it is the opt-in.
function validateAnimPlaying(v: string | null): boolean {
  return v !== 'false';
}
function validateAnimInPlace(v: string | null): boolean {
  return v === 'true';
}

// Both maps are adversarial: projectImport writes them straight out of an
// imported project block. The bounds map was a bare CAST while its sibling had
// a per-entry whitelist — `{min:'abc'}` makes the slider's step NaN and
// `{min:5,max:0}` leaves a control that cannot move.
function validateUniformBounds(raw: string | null): Record<string, UniformBounds> {
  return raw ? sanitizeUniformBounds(JSON.parse(raw, safeJsonReviver)) : {};
}

function validateUniformValues(raw: string | null): Record<string, number | string> {
  return raw ? sanitizeUniformValues(JSON.parse(raw, safeJsonReviver)) : {};
}

/**
 * Module-level OBJ text cache: each model is fetched at most once per session
 * (teapot ~256KB, bunny ~3.1MB). The PARENT does this fetch because it runs
 * in the app's real origin where CORS never applies — the sandboxed preview
 * iframe's opaque origin turns the same request into a CORS fetch that
 * generic hosts reject (the deploy-only teapot/bunny failure). The text is
 * fed to the iframe via postMessage (fs:obj-model). A failed fetch is
 * evicted so a transient network error can retry on the next iframe load.
 */
const objTextCache = new Map<'teapot' | 'bunny', Promise<string>>();
function fetchObjText(geometry: 'teapot' | 'bunny'): Promise<string> {
  let p = objTextCache.get(geometry);
  if (!p) {
    p = fetch(getModelUrl(geometry)).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching model`);
      return r.text();
    });
    p.catch(() => objTextCache.delete(geometry));
    objTextCache.set(geometry, p);
  }
  return p;
}

/**
 * Analyser settings for ONE live-audio node kind, as a VALUE-stable string —
 * plus, via the empty string, whether the graph contains such a node at all.
 *
 * Shared by the Mic and Audio Input selectors rather than written twice: the two
 * nodes declare the same `smoothing`/`gain` sockets and resolve them by the same
 * split (gain in the shader, smoothing on the CPU), so a copy here would be two
 * places to fix the next time that split moves.
 *
 * See the call site for why this returns a joined string rather than an object,
 * and why absent keys are spelled `NaN` rather than `''`.
 */
function liveAudioSettingsKey(
  s: { nodes: AppNode[]; edges: AppEdge[] },
  registryType: string,
): string {
  const n = s.nodes.find((x) => x.data.registryType === registryType);
  if (!n) return '';
  const v = getNodeValues(n);
  // `smoothing` is an exposed socket, but unlike `gain` it cannot be resolved
  // in the shader: it sets the AnalyserNode's smoothingTimeConstant, which
  // lives on the CPU in the audio thread. So a wired edge is resolved by
  // EVALUATING its upstream chain on the CPU — the same evaluator that drives
  // the node-card previews. That means it follows constants, sliders and
  // arithmetic, and reads 0 for GPU-only sources (uv, position) which have no
  // CPU value; the alternative was a socket that silently did nothing.
  // Guarded on the edge existing, so a graph that doesn't wire it pays one
  // lookup rather than a graph walk on every store notify.
  //
  // getTargetEdges, NOT raw s.edges: with the smoothing feeder inside a
  // COLLAPSED group the raw scan sees a boundary edge whose source is the
  // GROUP id, and evaluateNodeOutput on a group node returns nothing — the
  // wire silently stops setting smoothingTimeConstant the moment its frame is
  // collapsed. getTargetEdges reports the real producer. The `source !== n.id`
  // self-edge guard stays (a node feeding its own smoothing would recurse).
  let smoothing: string | number | undefined = v.smoothing;
  const se = getTargetEdges(s.nodes, s.edges, n.id).find(
    (x) => x.targetHandle === 'smoothing' && x.source !== n.id,
  );
  if (se) {
    // Per-SOCKET: a wire from an HSL node's Lightness must set
    // smoothingTimeConstant from L, not from channel 0's Hue.
    const out = evaluateEdgeSource(se, s.nodes, s.edges, 0);
    if (out && out.length > 0 && Number.isFinite(out[0])) smoothing = out[0];
  }
  return `${smoothing ?? NaN}|${v.gain ?? NaN}`;
}

export function ShaderPreview() {
  const previewCode = useAppStore((s) => s.previewCode);
  const shaderName = useAppStore((s) => s.shaderName);
  const language = useAppStore((s) => s.language);
  const previewMesh = useAppStore((s) => s.previewMesh);
  const setPreviewMesh = useAppStore((s) => s.setPreviewMesh);
  // The top bar's WGSL/GLSL toggle (session-only store flag — see useAppStore).
  const forceWebGL2 = useAppStore((s) => s.previewForceWebGL2);
  const setPreviewForceWebGL2 = useAppStore((s) => s.setPreviewForceWebGL2);
  /**
   * Which renderer the CURRENT preview document reported at boot
   * (`fs:backend`, posted from the pre-flight's boot()). LABEL-ONLY — the
   * report is untrusted (see AUTO_IS_WEBGL2) and a forced document's own
   * accurate 'webgl2' report would otherwise mislock the toggle for the
   * whole rebuild window after unforcing. Last-known-wins across rebuilds:
   * the fresh document re-reports at scene boot, and keeping the stale value
   * in the gap stops the label flickering on every shader edit. Null only
   * before the very first report.
   */
  const [activeBackend, setActiveBackend] = useState<'webgpu' | 'webgl2' | null>(null);
  // Locked = auto mode already yields WebGL2, so the toggle has nothing to
  // switch (Safari / no navigator.gpu) — derived from AUTO_IS_WEBGL2, never
  // from the report. Locked rather than hidden: a control that vanishes
  // per-browser reads as a regression, one that explains itself on hover
  // doesn't. aria-disabled, not disabled — WebKit skips the native tooltip
  // on a genuinely disabled control (the WorkFolder rule).
  const backendLocked = !forceWebGL2 && AUTO_IS_WEBGL2;
  // The label folds AUTO_IS_WEBGL2 in too, so Safari reads GLSL from the
  // first frame instead of flashing a WGSL prediction until the report.
  const backendIsGlsl = forceWebGL2 || AUTO_IS_WEBGL2 || activeBackend === 'webgl2';

  // Material settings from the output node. Narrow selector: a position/
  // selection-only store notify replaces the node OBJECT but keeps its .data
  // (and thus materialSettings) reference — Object.is bails, so the whole
  // ~1000-line panel no longer re-renders on every drag pointermove the way
  // the old whole-array nodes/edges subscriptions made it.
  const materialSettings = useAppStore((s) =>
    (findDefaultOutput(s.nodes)?.data as
      { materialSettings?: PreviewOptions['materialSettings'] } | undefined)?.materialSettings,
  );

  // Connected property-uniform names, folded to a primitive key so only a real
  // membership change re-renders; the O(N+E) scan runs once per store notify
  // for this single component. The rule itself — including the emitted-vs-
  // stored name collision handling — lives in utils/connectedUniforms (pure,
  // tested). `nodeVarNames` comes from the same graphToCode pass that produced
  // `previewCode`, so the names it yields describe the same module.
  const connectedPropNamesKey = useAppStore((s) =>
    connectedUniformNamesKey(s.nodes, s.edges, s.nodeVarNames),
  );

  // All preview prefs re-read on `fs:project-imported` — a project file
  // carries them, and the overlay + iframe srcDoc inputs must pick up the
  // imported values without a page reload.
  const [geometry, setGeometry] = usePersistedState('fs:previewGeometry', validateGeometry, { reloadOnProjectImport: true });
  const [playing, setPlaying] = usePersistedState('fs:previewPlaying', validatePlaying, { reloadOnProjectImport: true });
  const [lighting, setLighting] = usePersistedState('fs:previewLighting', validateLighting, { reloadOnProjectImport: true });

  // The env-lighting entry in the Light dropdown exists only while an
  // environment map is wired to the Output node's `env` socket. The selector
  // returns a cheap STRING (the image's honest display name, '' when unwired,
  // 'Environment' for a non-image env source such as a constant colour) so a
  // position-only graph notify bails on Object.is instead of re-rendering the
  // whole preview — the MicNode/edgeValueLabel subscription pattern.
  const envMapName = useAppStore((s) => {
    // The DEFAULT output. An env map wired to a TARGETED one lights only that
    // mesh, so naming the Light dropdown after it would misdescribe the scene.
    const out = findDefaultOutput(s.nodes);
    // getTargetEdges, NOT raw s.edges: a feeder inside a COLLAPSED group is
    // reached through a rewritten boundary edge whose source is the group id,
    // so a raw scan finds an edge whose `source` node has no registry def and
    // reports the generic 'Environment' (or nothing) instead of the image's
    // name. Same fix as OutputNode's edge-value labels.
    const edge = out
      ? getTargetEdges(s.nodes, s.edges, out.id).find((e) => e.targetHandle === 'env')
      : undefined;
    if (!edge) return '';
    const src = s.nodes.find((n) => n.id === edge.source);
    if (!src) return '';
    if (src.data.registryType !== 'imageNode') return 'Environment';
    const v = getNodeValues(src);
    return displayImageFileName(v.fileName, v.imageB64) || 'Environment';
  });

  // 'env' with no map attached would bake the EMPTY light rig — a black
  // void. Render/post/bake from the effective mode, and normalize the stored
  // pref once the map is gone so the dropdown never points at a missing
  // option.
  const effLighting: LightingMode = lighting === 'env' && !envMapName ? 'studio' : lighting;
  useEffect(() => {
    if (lighting === 'env' && !envMapName) setLighting('studio');
  }, [lighting, envMapName, setLighting]);
  const [subdivision, setSubdivision] = usePersistedState('fs:previewSubdivision', validateSubdivision, { reloadOnProjectImport: true });
  const [bgColor, setBgColor] = usePersistedState('fs:previewBgColor', validateBgColor, { reloadOnProjectImport: true });

  // Restore the previous session's dropped mesh from the IndexedDB cache. The
  // read is async, so `validateGeometry` has already downgraded a stored
  // 'custom' to 'sphere' by now (no mesh was loaded when it ran) — that's what
  // bootGeometryWasCustom() remembers, sampled at module init before the
  // downgrade was written back. Restoring the mesh then re-selects it.
  //
  // A zip import or a drop can land first (both are synchronous); either wins,
  // and the cache read is discarded rather than overwriting live state.
  useEffect(() => {
    if (useAppStore.getState().previewMesh) return;
    let cancelled = false;
    void loadPreviewMeshFromCache().then((mesh) => {
      if (cancelled || !mesh) return;
      if (useAppStore.getState().previewMesh) return;
      // persist:false — these bytes came straight OUT of the cache.
      useAppStore.getState().setPreviewMesh(mesh, { persist: false });
      if (bootGeometryWasCustom()) setGeometry('custom');
    });
    return () => { cancelled = true; };
  }, [setGeometry]);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Horizontal overflow of the top control bar — see the bar's own comment.
  const ctlRef = useRef<HTMLDivElement>(null);
  const ctlArrows = useScrollArrows(ctlRef);
  const rootRef = useRef<HTMLDivElement>(null);

  // Fullscreen toggle for the whole preview pane (controls + canvas + property
  // sliders stay visible). The iframe already carries `allow="fullscreen *"`,
  // but nothing ever *triggered* fullscreen — A-Frame's own vr-mode-ui button
  // is disabled for the editor preview, so there was no affordance at all. We
  // fullscreen the parent-owned root element (not the sandboxed iframe), so no
  // Permissions-Policy delegation is involved; Safari needs the webkit-prefixed
  // request/exit/element APIs, hence the fallbacks below.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const doc = document as FsDocument;
    const onChange = () => {
      const fsEl = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
      setIsFullscreen(fsEl === rootRef.current);
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);
  const handleToggleFullscreen = useCallback(() => {
    const el = rootRef.current as FsElement | null;
    const doc = document as FsDocument;
    const fsEl = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    if (fsEl) {
      (document.exitFullscreen ?? doc.webkitExitFullscreen)?.call(document);
    } else if (el) {
      (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
    }
  }, []);

  // ── Model animation ────────────────────────────────────────────────────
  // A-Frame core has no animation-mixer, so an animated glTF used to load as a
  // static rest-pose mesh. The iframe's `gltf-anim` component owns the mixer
  // and this half owns the controls: a play/pause + in-place pill and the
  // scrubber between the two existing clusters.
  const [animInfo, setAnimInfo] = useState<AnimInfo | null>(null);
  const [animPlaying, setAnimPlaying] = usePersistedState('fs:previewAnimPlaying', validateAnimPlaying);
  const [animInPlace, setAnimInPlace] = usePersistedState('fs:previewAnimInPlace', validateAnimInPlace);

  /**
   * FPS / frame-time readout over the viewport's top-right corner. The iframe
   * owns the render loop and therefore the measurement (`fs-stats`); this half
   * only asks for it and paints the number — the same split podest uses.
   *
   * The readout is written IMPERATIVELY into a ref'd node rather than held in
   * state: reports land ~4x/s and routing them through React would re-render
   * this whole panel at that rate, the same reason the scrubber thumb and the
   * mic meter are hand-written.
   */
  const [showStats, setShowStats] = usePersistedState('fs:previewStats', validateStats);
  const statsRef = useRef<HTMLDivElement>(null);
  const showStatsRef = useRef(showStats);
  /** Placeholder until the first report (~250 ms) so the chip is never blank. */
  const STATS_PLACEHOLDER = '— FPS · — ms';

  const timelineRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  /**
   * Last time the iframe reported, in seconds. Survives an iframe REBUILD (a
   * shader edit swaps srcDoc, so the model reloads and the mixer restarts at
   * 0) — without it, editing a node while an animation runs would snap the
   * model back to frame 0 on every keystroke's debounce.
   */
  const animTimeRef = useRef(0);
  /** Mirror of the two toggles for the mount-once message handler. */
  const animStateRef = useRef({ playing: animPlaying, inPlace: animInPlace });
  const animInfoRef = useRef<AnimInfo | null>(null);
  /** True while the user is dragging the scrubber — incoming times are ignored. */
  const scrubbingRef = useRef(false);
  useEffect(() => { animInfoRef.current = animInfo; }, [animInfo]);

  /**
   * Which clip to play. Held in a REF, not persisted: an index means nothing
   * across models (clip 3 of a walk cycle is clip 3 of nothing in the next
   * file), so it survives a shader-edit rebuild — where the same model
   * reloads — and resets with `geometryRebuildKey` alongside the playhead.
   * The rendered value comes from `animInfo.clip`, i.e. from what the stage
   * says it is actually playing, so the tick can never point at a clip the
   * component clamped away.
   */
  const animClipRef = useRef(0);
  const [clipMenuOpen, setClipMenuOpen] = useState(false);
  const animPillRef = useRef<HTMLDivElement>(null);
  const animClipsBtnRef = useRef<HTMLButtonElement>(null);
  /** When a long-press opened the menu — the synthesized-contextmenu window. */
  const clipMenuTouchTsRef = useRef(0);
  // Touch/pen counterpart to the right-click, the Toolbar EXPORT precedent.
  // Bound to the whole PILL, not the ▶: a near-miss on a 28px target is the
  // common case, and a gesture that silently does nothing an inch away from
  // where it works reads as the feature being broken. The ☰ button is
  // excluded (podest's twin has the same guard): it already opens on tap, so
  // a long-press starting on it would open at 500ms and the button's own
  // toggle click on finger-lift would immediately close it again.
  useLongPress(animPillRef, (target) => {
    if (animClipsBtnRef.current?.contains(target)) return;
    clipMenuTouchTsRef.current = performance.now();
    setClipMenuOpen(true);
  }, { disabled: !animInfo });

  /**
   * Move the scrubber. IMPERATIVE on purpose: the iframe reports ~30×/s while
   * playing, and routing that through React state would re-render this
   * ~1700-line panel at frame rate — the same reason the mic meter and the
   * on-node live edge values are written by hand.
   *
   * The thumb's width is read from the element rather than duplicated here, so
   * the CSS stays the single source of truth for it: the travel is inset by
   * half a thumb at each end, which is exactly the span the line is drawn over.
   */
  const paintThumb = useCallback((time: number) => {
    const thumb = thumbRef.current;
    const dur = animInfoRef.current?.duration ?? 0;
    if (!thumb || dur <= 0) return;
    const w = thumb.offsetWidth || 20;
    const f = Math.max(0, Math.min(1, time / dur));
    thumb.style.left = `calc(${w / 2}px + ${f} * (100% - ${w}px))`;
  }, []);

  /** Pointer x → clip time, over the same inset span paintThumb writes into. */
  const timeFromPointer = useCallback((clientX: number): number => {
    const track = timelineRef.current;
    const dur = animInfoRef.current?.duration ?? 0;
    if (!track || dur <= 0) return 0;
    const w = thumbRef.current?.offsetWidth || 20;
    const rect = track.getBoundingClientRect();
    const usable = rect.width - w;
    if (usable <= 0) return 0;
    const f = Math.max(0, Math.min(1, (clientX - rect.left - w / 2) / usable));
    return f * dur;
  }, []);

  const seekAnim = useCallback((time: number) => {
    animTimeRef.current = time;
    paintThumb(time);
    iframeRef.current?.contentWindow?.postMessage({ type: 'fs:anim-seek', time }, '*');
  }, [paintThumb]);

  // Push the toggles into the running document. Deliberately NOT gated on
  // animInfo: the component's message listener is installed at `init`, i.e.
  // before the model finishes loading, so an early post is stored in the
  // component's schema and is already correct when the clip binds — which is
  // what keeps a paused preview from playing one frame after every rebuild.
  useEffect(() => {
    animStateRef.current = { playing: animPlaying, inPlace: animInPlace };
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'fs:anim-set', playing: animPlaying, inPlace: animInPlace },
      '*',
    );
  }, [animPlaying, animInPlace]);

  /** Pick a clip. The stage re-reports, which is what resizes the scrubber. */
  const selectClip = useCallback((index: number) => {
    animClipRef.current = index;
    animTimeRef.current = 0;
    iframeRef.current?.contentWindow?.postMessage({ type: 'fs:anim-set', clip: index }, '*');
  }, []);

  // Defer the iframe's srcDoc until the container element has non-zero
  // dimensions. Without this gate, on first page load the iframe boots
  // before the flex layout has resolved — A-Frame's WebGPU renderer then
  // initializes with a 0×0 canvas, dawn rejects the framebuffer texture
  // ("texture size … is empty"), and the renderer is left in a broken
  // state that paints the mesh solid red. Removing-and-adding an edge
  // appeared to "fix it" only because that triggered a previewCode change
  // → srcDoc rewrite → iframe rebuild, which happened to land after
  // layout had settled.
  const [containerReady, setContainerReady] = useState(false);

  // A-Frame's own loading screen is disabled, so between a fresh srcDoc and the
  // first painted frame — a WebGPU pre-flight, a ~1MB bundle fetch/parse and a
  // shader compile, i.e. seconds — the pane was simply blank, which is
  // indistinguishable from a crash. Cleared by fs:preview-ready (success) or
  // fs:preview-error (failure), with a timeout below so it can never stick.
  const [compiling, setCompiling] = useState(true);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      setContainerReady(true);
      return;
    }
    const obs = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.contentRect.width > 0 && e.contentRect.height > 0) {
          setContainerReady(true);
          obs.disconnect();
          return;
        }
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Latest camera position reported by the iframe. Stored in a ref (not state)
  // so live position updates from inside the iframe don't retrigger the
  // useMemo that rebuilds the iframe — that would create an infinite loop.
  // The memo reads `current` at rebuild time and embeds it as the restore
  // target for the next iframe instance.
  // The model key the CURRENT document was built for, readable from the
  // message handler (which mounts once, with [] deps, so it cannot close over
  // it). Kept in sync with geometryRebuildKey below.
  const modelKeyRef = useRef<string>('');
  const cameraPosRef = useRef<CameraPosition | null>(loadCameraPos());
  const rotationRef = useRef<CameraPosition | null>(loadRotation());

  // ── Model / file drop surface ──────────────────────────────────────────
  // Two regions feed the same handler (podest's exact pattern): the parent-
  // owned chrome (controls bar, overlays) via the root element's drag props,
  // and the sandboxed iframe — which swallows drag events over the whole 3D
  // view, so the generated document forwards them over postMessage
  // (fs:preview-drag signal + fs:preview-drop File objects; see the forwarder
  // in tslToPreviewHTML.ts). The veil shows while EITHER region reports an
  // active drag, with a safety timeout so an aborted drag (Esc / drop outside
  // the window — no reliable leave event) can never strand it; a live drag
  // keeps re-arming the timeout via the dragover heartbeat.
  const [dropVeil, setDropVeil] = useState(false);
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const dragDepthRef = useRef(0);
  const iframeDragRef = useRef(false);
  const veilTimerRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const refreshDropVeil = useCallback(() => {
    const show = dragDepthRef.current > 0 || iframeDragRef.current;
    setDropVeil(show);
    if (veilTimerRef.current !== null) {
      window.clearTimeout(veilTimerRef.current);
      veilTimerRef.current = null;
    }
    if (show) {
      veilTimerRef.current = window.setTimeout(() => {
        dragDepthRef.current = 0;
        iframeDragRef.current = false;
        setDropVeil(false);
        veilTimerRef.current = null;
      }, 1500);
    }
  }, []);

  /** Transient parent-owned notice (invalid drop, unreadable file, …). */
  const showDropNotice = useCallback((msg: string) => {
    setDropNotice(msg);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      setDropNotice(null);
      noticeTimerRef.current = null;
    }, 6000);
  }, []);

  useEffect(() => () => {
    if (veilTimerRef.current !== null) window.clearTimeout(veilTimerRef.current);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
  }, []);

  const loadMeshFile = useCallback(async (file: File) => {
    try {
      // Size gate BEFORE the read — a hostile/oversized drop must not force a
      // multi-hundred-MB arrayBuffer allocation just to be rejected.
      if (file.size > MESH_MAX_BYTES) {
        showDropNotice(`${t('Model too large', language)} (${(file.size / 1024 / 1024).toFixed(1)} MB — max ${MESH_MAX_BYTES / 1024 / 1024} MB).`);
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      // createPreviewMesh sanitizes the name at the store boundary — every
      // consumer (zip export entry, README text, option label) reads the
      // stored value, never the raw file name.
      const result = createPreviewMesh(file.name, bytes);
      if ('error' in result) {
        // The util's fixed error strings double as t() keys (English falls
        // through for the dynamic ones).
        showDropNotice(t(result.error, language));
        return;
      }
      setPreviewMesh(result.mesh);
      setGeometry('custom');
    } catch (e) {
      showDropNotice(`${t('Could not read the model file', language)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [setPreviewMesh, setGeometry, showDropNotice, language]);

  // One dispatch for every preview drop, wherever it landed. A model file
  // becomes the custom preview mesh; a shader .js/.zip routes through the
  // SAME shared project-import path the canvas and code-panel drops use
  // (there is no event-bubbling fallback — forwarded iframe drops arrive as
  // postMessage, so this surface must handle or reject everything itself).
  const handleDroppedFiles = useCallback((files: File[], source: 'dom' | 'iframe' = 'dom') => {
    const model = files.find((f) => detectMeshKind(f.name) !== null);
    const zip = files.find((f) => isZipFile(f));
    const script = zip ? null : files.find((f) => /\.(js|mjs|tsl|txt)$/i.test(f.name)) ?? null;

    // SECURITY: an iframe-forwarded drop is only as trustworthy as the
    // sandbox that forwarded it — adversarial shader code can forge
    // fs:preview-drop with a File it constructed itself. A shader import
    // REPLACES the whole project, so iframe-originated .js/.zip needs an
    // explicit user click; a model file only swaps the session preview mesh
    // (low blast radius) and stays immediate. Parent-chrome drops are real
    // DOM events and skip the prompt.
    let shaderFile = zip ?? script;
    if (shaderFile && source === 'iframe') {
      const ok = window.confirm(
        `${t('Load the dropped shader file? It replaces the current project.', language)}\n(${shaderFile.name})`,
      );
      if (!ok) shaderFile = null;
    }

    // Shader import FIRST (it clears/overwrites the mesh — see
    // importShaderText/importShaderZip), THEN the dropped model — so a
    // combined shader+model drop deterministically shows the dropped model
    // (podest's pairing semantics) instead of racing two file reads.
    let shaderP: Promise<unknown> | null = null;
    if (shaderFile && zip && shaderFile === zip) {
      shaderP = importShaderZip(zip).then(
        (r) => { if (r === null) showDropNotice(t('The zip holds no shader script', language)); },
        (e: unknown) => showDropNotice(String(e instanceof Error ? e.message : e)),
      );
    } else if (shaderFile) {
      shaderP = shaderFile.text().then(
        (text) => { importShaderText(text); },
        (e: unknown) => showDropNotice(String(e instanceof Error ? e.message : e)),
      );
    }
    if (model) {
      if (shaderP) void shaderP.finally(() => { void loadMeshFile(model); });
      else void loadMeshFile(model);
    }
    if (!model && !zip && !script) {
      showDropNotice(t('Drop a 3D model (.obj / .glb / .gltf) or a shader (.js / .zip)', language));
    }
  }, [loadMeshFile, showDropNotice, language]);

  // Ref mirror so the mount-once message handler below sees the latest
  // dispatch without re-binding (same pattern as uniformValuesRef).
  const handleDroppedFilesRef = useRef(handleDroppedFiles);
  useEffect(() => { handleDroppedFilesRef.current = handleDroppedFiles; }, [handleDroppedFiles]);

  // If the mesh is cleared while 'custom' is selected (a bare .js import
  // clears stale meshes and — on the script path — fires no prefs re-read),
  // fall back to a sphere so the select never points at an unmounted option.
  useEffect(() => {
    if (geometry === 'custom' && !previewMesh) setGeometry('sphere');
  }, [geometry, previewMesh, setGeometry]);

  // Property uniforms detected from the generated code, filtered to only those
  // whose property node has at least one outgoing edge (i.e. is connected).
  // BOTH property kinds must be scanned: with only property_float here, the
  // presence of one float property made the connected-names set float-only and
  // silently filtered every colour picker out of the overlay.
  /**
   * The Mic node's analyser settings, selected as a VALUE-stable string, plus
   * (via the empty string) whether the graph contains a Mic node at all.
   *
   * Not the values object: `getNodeValues` falls back to a fresh `{}` when a
   * node has no stored values, so an object-returning selector would mint a new
   * identity on every `s.nodes` change — i.e. re-render this ~1000-line panel
   * on every drag pointermove, the exact trap connectedPropNamesKey documents.
   * A joined string compares by value, so Object.is bails until a setting
   * really changes.
   *
   * Absent keys are joined as the literal `NaN`, NOT `''`: readMicSettings
   * coerces with Number(), and `Number('') === 0` — an empty sentinel would
   * silently turn a missing `smoothing` into 0 (no smoothing at all) instead of
   * the 0.8 default. `Number('NaN')` is NaN, which the clamp maps to the
   * default as intended.
   *
   * KNOWN LIMITATION: one analyser serves each SESSION, so a second node of the
   * same kind has its settings ignored. `find` makes that deterministic (first
   * in node order) rather than arbitrary. Two Mic nodes is a strange thing to
   * want — they would hear the same room — but the node description says so.
   * (A Mic node and an Audio Input node are two DIFFERENT sessions and do not
   * contend: see the header of utils/audioSession.ts.)
   */
  const micSettingsKey = useAppStore((s) => liveAudioSettingsKey(s, 'micNode'));
  const hasMicNode = micSettingsKey !== '';
  const micSettings = useMemo(() => {
    const [smoothing, gain] = micSettingsKey.split('|');
    return readMicSettings({ smoothing, gain });
  }, [micSettingsKey]);

  // The Audio Input node resolves its analyser settings by exactly the same
  // rules — same sockets, same CPU-vs-shader split — so it shares the selector.
  const audioSettingsKey = useAppStore((s) => liveAudioSettingsKey(s, 'audioInput'));
  const hasAudioNode = audioSettingsKey !== '';
  const audioSettings = useMemo(() => {
    const [smoothing, gain] = audioSettingsKey.split('|');
    return readMicSettings({ smoothing, gain });
  }, [audioSettingsKey]);

  const allUniforms = useMemo(() => extractUniforms(previewCode), [previewCode]);

  /**
   * The mic uniforms the CURRENT shader actually reads — the pump's targets.
   *
   * Gated on the graph really containing a Mic node, because an emitted
   * `const mic1_bass = uniform(0);` and a user property that happens to be
   * NAMED `mic1_bass` are textually identical — nothing in the code can tell
   * them apart. Without the gate, such a property would vanish from the
   * Uniforms overlay in a graph with no microphone in it at all. (With a Mic
   * node present the collision cannot arise: graphToCode claims each
   * `<var>_<channel>` as a claimName alias, so a property is renamed instead.)
   */
  const micUniformNames = useMemo(
    () =>
      hasMicNode
        ? allUniforms
            .filter((u) => liveAudioVarBaseOf(u.name) === MIC_VAR_BASE)
            .map((u) => u.name)
        : [],
    [allUniforms, hasMicNode],
  );

  /**
   * The same, for the Audio Input node. Split by the uniform's variable BASE
   * rather than by a single "is live audio" predicate, because each list is the
   * driving target of a DIFFERENT capture session — the routing the pump does.
   */
  const audioUniformNames = useMemo(
    () =>
      hasAudioNode
        ? allUniforms
            .filter((u) => liveAudioVarBaseOf(u.name) === AUDIO_VAR_BASE)
            .map((u) => u.name)
        : [],
    [allUniforms, hasAudioNode],
  );

  /**
   * Every uniform the shader has, minus the mic's. Connection-agnostic ON
   * PURPOSE — this is the list the override bookkeeping works from. A value
   * edited while its property is DISCONNECTED has no overlay row, so a
   * connection-filtered list would never notice it and a stale stored value
   * would re-apply the instant the wire landed: the same trap, one wire away.
   */
  const nonMicUniforms = useMemo(() => {
    // Mic uniforms are split off BEFORE anything else looks at this list, and
    // that one move is what keeps every other uniform surface correct:
    //   - the overlay doesn't render four sliders the pump overwrites 60×/s;
    //   - handleReset can't push them, and therefore can't write mic-derived
    //     values into the `usePersistedState` uniformValues (i.e. to DISK),
    //     which would contradict "nothing is recorded";
    //   - "Set as default" can't try to bake a live value into a graph node
    //     that has no `value` to bake it into.
    // It also covers the ALL_UNIFORMS branch below, where a graph with no
    // property nodes would otherwise fall through to "show everything".
    //
    // BOTH live-audio nodes are split off here. Missing the Audio Input half
    // would reinstate every one of the bullets above for it — including writing
    // its levels to DISK through the persisted uniformValues.
    const liveNames = new Set([...micUniformNames, ...audioUniformNames]);
    return allUniforms.filter((u) => !liveNames.has(u.name));
  }, [allUniforms, micUniformNames, audioUniformNames]);

  // The overlay ROWS: only properties whose node has at least one outgoing edge
  // (i.e. is connected). BOTH property kinds must be scanned: with only
  // property_float here, the presence of one float property made the connected-
  // names set float-only and silently filtered every colour picker out.
  const uniforms = useMemo(() => {
    // If no property nodes exist (e.g. direct-assignment mode), show all.
    if (connectedPropNamesKey === ALL_UNIFORMS) return nonMicUniforms;
    const connectedNames = new Set(connectedPropNamesKey.split(' ').filter(Boolean));
    return nonMicUniforms.filter((u) => connectedNames.has(u.name));
  }, [nonMicUniforms, connectedPropNamesKey]);

  const mic = useMicPump({
    iframeRef,
    micUniformNames,
    settings: micSettings,
    audioUniformNames,
    audioSettings,
  });

  // Per-uniform min/max — persisted across reloads, keyed by uniform name
  const [showUniforms, setShowUniforms] = useState(true);
  const [uniformBounds, setUniformBounds] = usePersistedState('fs:previewUniformBounds', validateUniformBounds, { serialize: JSON.stringify, reloadOnProjectImport: true });

  /**
   * Live slider values — overlay-local (don't write back to the graph, so
   * tweaking a slider doesn't trigger a graph re-sync and tear the iframe
   * down) but persisted so a refresh, an unrelated rebuild, or a delete + undo
   * of a property node preserves user tuning.
   *
   * NOTHING IS SEEDED any more. This map used to be filled from the authored
   * default the first time a uniform was SEEN, which armed the whole trap for
   * a user who had never opened this overlay: from then on the entry existed,
   * so the fs:preview-ready re-push below decided the value, and editing the
   * number on the node had no visible effect. An entry now exists only because
   * the user tuned a slider or imported a file — so "no entry" means "the graph
   * decides", and absence is already handled everywhere (the row falls back to
   * u.defaultValue, the re-push only iterates stored names, and
   * planUniformDefaults skips an undefined value).
   *
   * Still deliberately NOT pruned: a name that leaves the shader keeps its
   * value, so delete + undo — and re-adding a property with the same name and
   * the same number — restores the user's tuning.
   */
  const [uniformValues, setUniformValues] = usePersistedState('fs:previewUniformValues', validateUniformValues, { serialize: JSON.stringify, reloadOnProjectImport: true });

  /**
   * Uniforms the preview is running at something OTHER than the graph's number
   * — DERIVED (`stored ≠ authored`), never remembered. A persisted baseline
   * would need a second key and a migration, and it would still be wrong:
   * "the literal for this NAME moved" is not "the user edited this number",
   * since which of two same-named properties owns the bare identifier follows
   * the nodes ARRAY order and a group drag can fake it.
   */
  const overrides = useMemo(
    () => overriddenUniforms(nonMicUniforms, uniformValues),
    [nonMicUniforms, uniformValues],
  );
  const overrideCount = Object.keys(overrides).length;

  // Refs for the message handler so it doesn't need to re-bind on every change
  const uniformValuesRef = useRef(uniformValues);
  /**
   * Every uniform the shader has (mic excluded), by name — the message
   * handler's and the revert button's view of the world.
   *
   * Built from nonMicUniforms, not from the connection-filtered `uniforms`:
   * the old kinds map covered only connected rows, so the fs:preview-ready
   * guard below short-circuited for every other name and could post a stored
   * '#rrggbb' at a float uniform. It is also what gives a DISCONNECTED
   * property's revert a default value to revert to.
   */
  const uniformInfoRef = useRef<Map<string, UniformInfo>>(new Map());
  /**
   * Fallback slider bounds, seeded per uniform from the value the row displays
   * and kept only while they still CONTAIN it (see fallbackBounds). They must
   * NOT be re-derived from the live value on each render: a range input whose
   * max tracks 2× its own value re-renders the thumb at a fixed 50% of a range
   * that moves with it, so every drag event reads the pointer against
   * goalposts the previous event just shifted — the value compounds
   * exponentially in BOTH drag directions and the displayed max climbs with
   * it. Containment is the safe middle: a value the slider emitted is inside
   * its own range by construction, so a drag can never re-seed; only a revert,
   * a Reset or a node edit can. Stored user bounds (uniformBounds) always win;
   * these only fill the gap until a bound field is edited.
   */
  const seededBoundsRef = useRef<Record<string, UniformBounds>>({});
  useEffect(() => {
    uniformInfoRef.current = new Map(nonMicUniforms.map((u) => [u.name, u]));
  }, [nonMicUniforms]);
  useEffect(() => { uniformValuesRef.current = uniformValues; }, [uniformValues]);

  // Single message handler for all iframe → parent traffic:
  // - fs:preview-ready: push all current uniform values to the freshly built iframe
  // - fs:camera: snapshot the latest camera position so it can be restored on next rebuild
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      // Only accept messages from our own preview iframe — any other window
      // posting fs:* messages must not be allowed to mutate persisted state.
      // The iframe is sandboxed (allow-scripts only, no allow-same-origin),
      // so e.origin will be "null"; identity is verified via e.source instead.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data as {
        type?: string; x?: number; y?: number; z?: number; fps?: number; ms?: number;
        on?: boolean; files?: unknown;
        has?: boolean; duration?: number; canInPlace?: boolean;
        name?: unknown; clip?: number; clips?: unknown; time?: number;
        backend?: unknown; geometry?: unknown; meshes?: unknown;
      } | null;
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'fs:model-meshes') {
        // What named sub-meshes the loaded model actually put in the scene.
        // Forgeable like every stage message — the document runs the loaded
        // shader — so it is validated before it is believed, and the KEY is
        // what makes a late report from a torn-down document (every shader
        // edit mints a fresh one) identifiable as stale rather than plausible.
        const inv = sanitizeMeshInventory(data.geometry, data.meshes);
        if (!inv || inv.key !== modelKeyRef.current) return;
        useAppStore.getState().setPreviewMeshInventory({ key: inv.key, meshes: inv.meshes });
        return;
      }
      if (data.type === 'fs:backend') {
        // Boot-time renderer report for the WGSL/GLSL toggle. Untrusted like
        // every stage message — only the two known literals are accepted.
        if (data.backend === 'webgpu' || data.backend === 'webgl2') setActiveBackend(data.backend);
        return;
      }
      if (data.type === 'fs:anim') {
        // The model finished loading and reported its clips (or the lack of
        // them). A zero/absent duration is treated as "no animation" — a clip
        // with no length has nothing to play and would divide the scrubber by
        // zero.
        const dur = typeof data.duration === 'number' && isFinite(data.duration) ? data.duration : 0;
        if (!data.has || dur <= 0) {
          setAnimInfo(null);
          return;
        }
        // The stage is sandboxed adversarial code, so this report is untrusted:
        // cap the clip count and every string length (podest applies the same
        // caps), and substitute a placeholder IN PLACE for a non-string entry
        // rather than compacting the array — compaction would shift every later
        // index, so the menu's active mark and onPick(i) would stop matching
        // the stage's real clip indices.
        const clips = Array.isArray(data.clips)
          ? data.clips.slice(0, 200).map((c) => (typeof c === 'string' ? c.slice(0, 120) : ''))
          : [];
        // The stage's own index, clamped by it. Used for DISPLAY only — which
        // row the picker ticks — and deliberately NOT written back into
        // animClipRef: a freshly built document reports its schema default of
        // 0, so adopting it would throw away the user's chosen clip on every
        // shader edit. The ref stays the request; the report is the answer.
        const clip = (typeof data.clip === 'number' && isFinite(data.clip) ? data.clip : 0) | 0;
        setAnimInfo({
          duration: dur,
          canInPlace: !!data.canInPlace,
          name: typeof data.name === 'string' ? data.name.slice(0, 120) : '',
          clip,
          clips,
        });
        // Restore this parent's state into the freshly built document: the
        // toggles AND the playhead, so a shader edit mid-animation resumes
        // where it was instead of snapping to frame 0.
        iframeRef.current?.contentWindow?.postMessage({
          type: 'fs:anim-set',
          // `clip` leads: the component re-derives duration/canInPlace and
          // rebinds at 0 on a clip change, so the time must follow it.
          clip: animClipRef.current,
          playing: animStateRef.current.playing,
          inPlace: animStateRef.current.inPlace,
          // Deliberately UNCLAMPED: `dur` here is the fresh document's
          // schema-default clip 0, not the clip this message selects, so a
          // Math.min against it truncated the remembered playhead of a longer
          // clip and flashed a wrong pose on every shader edit. The stage's
          // own seek() clamps against the post-swap duration.
          time: animTimeRef.current,
        }, '*');
        return;
      }
      if (data.type === 'fs:anim-time') {
        if (typeof data.time !== 'number' || !isFinite(data.time)) return;
        animTimeRef.current = data.time;
        // While the user drags, the pointer owns the thumb — a report landing
        // mid-gesture would fight it back to the playhead.
        if (!scrubbingRef.current) paintThumb(data.time);
        return;
      }
      if (data.type === 'fs:activity') {
        // Eval telemetry only (no-op otherwise): input INSIDE the preview is
        // invisible to the parent's own capture-phase listeners, so without
        // this a participant studying the shader for minutes reads as idle
        // and gets timed out of active time. Throttled in the stage; the
        // payload is a bare presence signal, never what was done.
        evalLog('activity', { source: 'preview' });
        return;
      }
      if (data.type === 'fs:stats') {
        // Frame-rate report from the stage's render loop (~4x/s while on).
        // Written straight to the DOM — see the showStats declaration for why
        // this must not go through state. The numbers come from the sandboxed
        // iframe, so they are coerced and bounded before they reach textContent
        // (podest's paintStats does the same); textContent only, never HTML.
        const el = statsRef.current;
        if (!el || !showStatsRef.current) return;
        const f = typeof data.fps === 'number' && isFinite(data.fps)
          ? Math.min(9999, Math.max(0, data.fps)) : 0;
        const ms = typeof data.ms === 'number' && isFinite(data.ms)
          ? Math.min(9999, Math.max(0, data.ms)) : 0;
        el.textContent = `${Math.round(f)} FPS · ${ms.toFixed(1)} ms`;
        return;
      }
      if (data.type === 'fs:preview-drag') {
        // Drag entered/left the iframe region — mirror the drop veil.
        iframeDragRef.current = !!data.on;
        refreshDropVeil();
        return;
      }
      if (data.type === 'fs:preview-drop') {
        // Files dropped ON the iframe, forwarded as structured-cloned File
        // objects. Zero both drag signals (an iframe drop produces no parent
        // dragleave) and accept only real Files — a forged message from
        // adversarial shader code can't smuggle anything else into the loader.
        dragDepthRef.current = 0;
        iframeDragRef.current = false;
        refreshDropVeil();
        const dropped = Array.isArray(data.files)
          ? data.files.filter((f): f is File => f instanceof File)
          : [];
        if (dropped.length) handleDroppedFilesRef.current(dropped, 'iframe');
        return;
      }
      if (data.type === 'fs:preview-error') {
        // The shader failed: no fs:preview-ready is coming. Drop the overlay so
        // the iframe's error message is readable.
        setCompiling(false);
        return;
      }
      if (data.type === 'fs:preview-ready') {
        setCompiling(false);
        const win = iframeRef.current?.contentWindow;
        if (!win) return;
        // Re-arm the stats reporter. Every shader edit swaps srcDoc, so the
        // fresh component boots OFF — without this replay the readout would go
        // dead on the first edit after switching it on and never come back,
        // which reads as the toggle being broken. podest replays the same
        // message from applyStateToStage for the same reason.
        if (showStatsRef.current) win.postMessage({ type: 'fs:stats-on', on: true }, '*');
        // Uniforms aren't baked into the iframe HTML — shaderloader
        // initialises them from the module schema, so the user's
        // current slider values need to be pushed every time a fresh
        // shader binds. The other hot-update channels (bg-color,
        // lighting, playing, geometry) ARE baked in via useMemo, so
        // re-pushing them here would just redo work the iframe already
        // did at boot — that's what was causing the post-refresh red
        // material (the re-push was racing with shader application).
        for (const [name, value] of Object.entries(uniformValuesRef.current)) {
          // Values persist by NAME across shader edits, so a name can come
          // back as a different KIND (float property deleted, colour property
          // re-added under the same name). A '#hex' string parseFloats to NaN
          // on a float uniform and a number is garbage to a THREE.Color —
          // push only kind-consistent values and let the schema default stand
          // otherwise.
          //
          // Names this shader doesn't have at all are now skipped outright.
          // The guard used to be `if (kind && …)` over a map built from the
          // CONNECTED rows only, and `kind` was undefined for exactly those
          // names — so the type check short-circuited and a leftover '#rrggbb'
          // could be posted at whatever float uniform later claimed the name.
          // Dropping them is behaviour-identical for the iframe, which already
          // ignores a name it has no uniform for.
          const info = uniformInfoRef.current.get(name);
          if (!info) continue;
          if (typeof value !== (info.kind === 'color' ? 'string' : 'number')) continue;
          // The rAF pump is the only thing that may write a live-audio uniform
          // (mic OR audio input). uniformValues should never contain one (they
          // are filtered out of `uniforms` before anything can store them), but
          // this map is `usePersistedState` with reloadOnProjectImport — an
          // imported project writes it — so an attacker-supplied
          // fs:previewUniformValues could otherwise pin one at a fixed value
          // after every rebuild. Defence in depth, one line; deliberately the
          // BROAD predicate, so it cannot fall behind the split above.
          if (isLiveAudioUniformName(name)) continue;
          win.postMessage({ type: 'fs:uniform', name, value }, '*');
        }
      } else if (data.type === 'fs:camera') {
        if (typeof data.x === 'number' && typeof data.y === 'number' && typeof data.z === 'number') {
          const pos = { x: data.x, y: data.y, z: data.z };
          cameraPosRef.current = pos;
          try { localStorage.setItem('fs:previewCameraPos', JSON.stringify(pos)); } catch { /* */ }
        }
      } else if (data.type === 'fs:rotation') {
        if (typeof data.x === 'number' && typeof data.y === 'number' && typeof data.z === 'number') {
          const rot = { x: data.x, y: data.y, z: data.z };
          rotationRef.current = rot;
          try { localStorage.setItem('fs:previewRotation', JSON.stringify(rot)); } catch { /* */ }
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Forward a "show me this mesh" hint to the sandboxed document. Fire and
  // forget by design: with no model loaded, the pane collapsed, or the iframe
  // mid-rebuild there is simply nothing to light up, and a hover hint that
  // reports its own failure would be worse than one that quietly does nothing.
  useEffect(() => {
    const onHighlight = (e: Event) => {
      const detail = (e as CustomEvent<MeshHighlightDetail>).detail;
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      const name = typeof detail?.name === 'string' ? detail.name : null;
      win.postMessage({ type: 'fs:highlight-mesh', name }, '*');
    };
    window.addEventListener(MESH_HIGHLIGHT_EVENT, onHighlight);
    return () => window.removeEventListener(MESH_HIGHLIGHT_EVENT, onHighlight);
  }, []);

  // Reset the iframe to defaults: camera home, studio lighting, default
  // subdivision, and every property uniform back to its shader-defined value.
  // Min/max bounds and bg color are user preferences, not part of the reset.
  const handleReset = useCallback(() => {
    // Camera: clear the saved view AND tell the live iframe to snap home now
    cameraPosRef.current = null;
    rotationRef.current = null;
    try { localStorage.removeItem('fs:previewCameraPos'); } catch { /* */ }
    try { localStorage.removeItem('fs:previewRotation'); } catch { /* */ }
    const win = iframeRef.current?.contentWindow;
    win?.postMessage({ type: 'fs:reset-camera' }, '*');

    // Lighting + subdivision back to defaults, playback paused. If these are
    // already at the default the setState is a no-op and no iframe rebuild
    // happens — that's fine because we still push uniform values via
    // postMessage below.
    setLighting('studio');
    setSubdivision(SUBDIVISION_DEFAULT);
    setPlaying(false);

    // Property uniforms back to their shader defaults: push them to the iframe
    // immediately (the rebuild path's fs:preview-ready handler is a safety net
    // for the case where lighting/subdivision did trigger a rebuild), then
    // FORGET the tuning rather than storing the defaults as if the user had
    // chosen them — writing them back re-armed the "stored value wins over the
    // node's number" trap for every uniform in the shader, which is the exact
    // opposite of what a button labelled Reset promises. Deleting also stops
    // this being the one place that PRUNES a map documented as never pruned:
    // the old whole-map replace wiped remembered values for every uniform
    // belonging to some other shader.
    const names = nonMicUniforms.map((u) => u.name);
    for (const u of nonMicUniforms) {
      win?.postMessage({ type: 'fs:uniform', name: u.name, value: u.defaultValue }, '*');
    }
    setUniformValues((prev) => clearUniformValues(prev, names));
  }, [nonMicUniforms]);

  // Slider drag / colour pick → live uniform update via postMessage
  const handleUniformChange = useCallback((name: string, value: number | string) => {
    setUniformValues((prev) => ({ ...prev, [name]: value }));
    iframeRef.current?.contentWindow?.postMessage({ type: 'fs:uniform', name, value }, '*');
  }, []);

  /**
   * Adopt the graph's number for one uniform — the escape hatch from a tuning
   * that has outlived its usefulness, reachable from the overlay row's chip.
   */
  const revertUniform = useCallback((name: string) => {
    const info = uniformInfoRef.current.get(name);
    if (!info || info.unparsed) return;
    setUniformValues((prev) => clearUniformValue(prev, name));
    delete seededBoundsRef.current[name];
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'fs:uniform', name, value: info.defaultValue }, '*');
  }, []);

  /**
   * An edit to a property node's NUMBER is the one act that outranks a value
   * tuned in this overlay. Without it the preview persisted tuning by name and
   * re-pushed it after every rebuild, so the node said one thing and the shader
   * ran another, forever — and on a binary channel like Discard that reads as
   * the app being broken.
   *
   * It arrives as an event rather than a store subscription so the panel
   * doesn't re-render on every pointermove (the same reason
   * connectedPropNamesKey and the imperative getState() reads exist), and the
   * store dispatches it from `updateNodeData`, the authoring chokepoint —
   * import, undo/redo, the code→graph sync and "Set as default" all go through
   * setNodes and correctly stay silent.
   *
   * Bounded by uniformInfoRef: it can only ever touch a name the CURRENT
   * shader has, which excludes mic uniforms structurally while still working
   * for a user property that happens to be called `mic1_bass` in a graph with
   * no microphone in it. The hot fs:uniform post is what makes a node scrub
   * drive the preview at pointer rate instead of waiting out the 200ms rebuild
   * debounce.
   */
  useEffect(() => {
    const onAuthored = (e: Event) => {
      const d = (e as CustomEvent).detail as { name?: unknown; value?: unknown } | null;
      if (!d || typeof d.name !== 'string') return;
      const info = uniformInfoRef.current.get(d.name);
      if (!info) return;
      if (typeof d.value !== (info.kind === 'color' ? 'string' : 'number')) return;
      const name = d.name;
      // Idempotent: only the first frame of a scrub has anything to delete, so
      // frames 2..N get the same object back, React bails out of the setState
      // and localStorage is never rewritten per pointermove.
      setUniformValues((prev) => clearUniformValue(prev, name));
      // Drop the frozen fallback bounds too — the row is about to display a
      // number that may sit far outside a range seeded from the old one.
      delete seededBoundsRef.current[name];
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'fs:uniform', name, value: d.value as number | string }, '*');
    };
    window.addEventListener('fs:uniform-authored', onAuthored);
    return () => window.removeEventListener('fs:uniform-authored', onAuthored);
  }, [setUniformValues]);

  /**
   * "Set as default" — bake the tuned uniform values into the graph, so they
   * become the shader's authored defaults (and thus the defaults in the
   * generated code, the Output tab, and the exported module's `schema`).
   *
   * Deliberately NOT a per-slider write: uniformValues stays overlay-local so
   * scrubbing doesn't tear the iframe down (see the note on the state above).
   * This one click is where the user opts INTO that rebuild.
   */
  const handleSetDefaults = useCallback(() => {
    const store = useAppStore.getState();
    // Read nodes imperatively — subscribing to s.nodes here would re-render
    // the whole panel on every drag pointermove (see connectedPropNamesKey).
    //
    // varNames comes from a FRESH graphToCode rather than store.nodeVarNames:
    // that map is only refreshed on the graph→code path, so after a code-panel
    // Apply (which ends in setNodes(..., 'code')) it is stale, and a stale
    // name would write a tuned value into the wrong node.
    const { varNames } = graphToCode(store.nodes, store.edges, NODE_REGISTRY);
    const plan = planUniformDefaults(store.nodes, varNames, uniforms, uniformValuesRef.current);
    // No clearing of uniformValues here on purpose: the bake moves the authored
    // default, so the now-redundant stored value stops being an override BY
    // DERIVATION and the chip goes out on its own. Clearing in the handler
    // would be wrong three ways — it would sit BELOW this early return, so a
    // re-bake of an already-baked value (planUniformDefaults skips anything
    // already equal to 9 significant digits) would strand a chip next to a
    // dead button; it would paint an intermediate render at a third value,
    // since the graph→code pass is a passive effect and previewCode can't
    // update in the same commit; and it would make undo of "Set as default"
    // lose the tuning it just baked.
    if (plan.size === 0) return;
    store.pushHistory(); // setNodes doesn't push on its own
    store.setNodes(applyUniformDefaults(store.nodes, plan), 'graph');
  }, [uniforms]);

  const handleBoundsChange = useCallback((name: string, key: 'min' | 'max', value: number) => {
    setUniformBounds((prev) => {
      // Baseline for the not-yet-edited bound = the SAME frozen seed the
      // slider row displays, so editing one bound never jumps the other.
      //
      // The third-order fallback must use the DISPLAYED value: with nothing
      // seeded into uniformValues any more, `uniformValuesRef.current[name]` is
      // undefined for every untuned uniform and seedBounds(undefined) collapses
      // to 0..1 — the fixed fallback that snapped dropped presets broken.
      const current =
        prev[name]
        ?? seededBoundsRef.current[name]
        ?? seedBounds(uniformValuesRef.current[name] ?? uniformInfoRef.current.get(name)?.defaultValue);
      return { ...prev, [name]: { ...current, [key]: value } };
    });
  }, []);

  // Project-file import (CodeEditor → dispatch `fs:project-imported`):
  // localStorage has already been overwritten with the imported preview prefs
  // by the time this fires. The usePersistedState hooks re-read their own
  // keys; the camera/rotation refs — seeded once at mount — are re-read here.
  useEffect(() => {
    const handler = () => {
      cameraPosRef.current = loadCameraPos();
      rotationRef.current = loadRotation();
    };
    window.addEventListener('fs:project-imported', handler);
    return () => window.removeEventListener('fs:project-imported', handler);
  }, []);

  // Model-backed geometries (built-in OBJs + a dropped mesh) ignore the
  // subdivision slider entirely. Folding the value to a constant in the dep
  // list (instead of the live state) means dragging the slider while a model
  // is selected doesn't rebuild the iframe to produce identical HTML.
  const effectiveSubdivision = isModelGeometry(geometry) ? 0 : subdivision;

  // Generate the iframe's HTML payload. We pass it via `srcDoc` rather than
  // building a blob URL because the iframe is sandboxed without
  // `allow-same-origin` — a parent-created blob URL belongs to the parent
  // origin and the browser refuses to load it into a foreign-origin frame
  // ("Not allowed to load local resource: blob:..."). srcdoc carries no
  // origin, so the iframe's content runs in its sandbox-issued opaque
  // origin, and the shader blob URL it creates internally is same-origin
  // to itself — which is what the shaderloader's fetch+import needs.
  //
  // Rebuilds are expensive under sandbox: each reload gets a new opaque
  // origin, Chrome's network cache partitioning treats that as a fresh
  // site, and the ~1MB A-Frame bundle re-fetches + re-parses every time.
  // So rebuilds are limited to props that need a fresh document: previewCode +
  // materialSettings (a new shader module) and `geometryRebuildKey`.
  //
  // The rebuild key collapses ALL primitives to one bucket so sphere↔cube↔plane
  // swaps DON'T rebuild — they hot-swap via cheap postMessage (the effect
  // below). A rebuild is forced only when an OBJ model is involved: any OBJ
  // target (the key carries the model name, so teapot↔bunny rebuilds too) and
  // crossing the OBJ↔primitive boundary. That boundary swap via setAttribute on
  // a live scene is exactly what crashes the r184 WebGPU renderer ("Cannot read
  // properties of undefined (reading 'id')" in getAttributes), so it must bake
  // into a fresh document. The closure still captures the current bgColor /
  // lighting / playing / subdivision, so any rebuild emits HTML with up-to-date
  // values; the useEffects below push those — and primitive geometry/subdivision
  // — live via postMessage without rebuilding.
  //
  // Only PROPERTY uniforms have a hot-update path; every other value (a Math
  // operand, a Mix factor, a noise scale, a vec component) is baked into the
  // generated TSL, so editing one lands here as a fresh document. DragNumberInput
  // fires a change per pointermove, so scrubbing one of those undebounced
  // restarts the rebuild faster than it can ever finish and the pane just
  // flickers until the drag stops. Debouncing collapses a whole scrub into a
  // single rebuild on release. Trailing-only, so first paint isn't delayed.
  const debouncedPreviewCode = useDebounced(previewCode, PREVIEW_REBUILD_DEBOUNCE_MS);

  // Dropped meshes key on their id so re-dropping a file (same name, new
  // bytes) still forces a fresh document — the feed only ever applies to the
  // document built for exactly that mesh instance.
  const geometryRebuildKey = isModelGeometry(geometry)
    ? (geometry === 'custom' ? `custom:${previewMesh?.id ?? 0}` : geometry)
    : '__primitive__';
  // Track it for the message handler, and drop a now-stale inventory the
  // moment the model changes rather than waiting for the new document to
  // report: a picker showing the previous model's meshes is worse than one
  // showing none, because only the second is obviously "not ready yet".
  useEffect(() => {
    modelKeyRef.current = geometryRebuildKey;
    const store = useAppStore.getState();
    if (store.previewMeshInventory && store.previewMeshInventory.key !== geometryRebuildKey) {
      store.setPreviewMeshInventory(null);
    }
  }, [geometryRebuildKey]);

  const previewHtml = useMemo(() => {
    const options: PreviewOptions = {
      geometry,
      animate: playing,
      materialSettings,
      bgColor,
      lighting: effLighting,
      subdivision: effectiveSubdivision,
      customModel: geometry === 'custom' && previewMesh
        ? { kind: previewMesh.kind, id: previewMesh.id }
        : null,
      // Backend is decided at document boot, so the toggle joins the rebuild
      // deps below (unlike bg/lighting/subdivision, which hot-update).
      forceWebGL2,
      // Read from the ref at memo time so the user's current camera angle
      // survives setting changes (subdivision, lighting, etc.) without
      // joining the dep list (which would cause an infinite rebuild loop).
      initialCameraPosition: cameraPosRef.current,
      initialRotation: rotationRef.current,
    };
    // Image payloads ride the generated code as short `fs-asset:` placeholders
    // (see engine/imageAssets.ts) — expand them here, where the module actually
    // runs. Nodes are read imperatively for the same reason as elsewhere in this
    // file: subscribing to `s.nodes` would re-render on every drag frame. That's
    // safe because the placeholder embeds a payload hash, so swapping an image
    // always changes `previewCode` and re-runs this memo.
    return tslToPreviewHTML(
      inlineImageAssetsFromNodes(debouncedPreviewCode, useAppStore.getState().nodes),
      options,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedPreviewCode, materialSettings, geometryRebuildKey, forceWebGL2]);

  // A new srcDoc means a full document reload, so raise the overlay again. Only
  // rebuilds go through here — the postMessage hot-update channels below mutate
  // the live scene and must NOT flash it.
  useEffect(() => {
    if (!containerReady) return;
    setCompiling(true);
    const id = setTimeout(() => setCompiling(false), COMPILE_OVERLAY_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [previewHtml, containerReady]);

  // A rebuild throws the old document away, so the animation controls must go
  // with it: the new one re-announces via fs:anim (or doesn't, if it has no
  // clips). Without this a model→sphere switch would leave a timeline
  // scrubbing a document that no longer has a mixer.
  useEffect(() => { setAnimInfo(null); }, [previewHtml]);

  /**
   * Ask the stage to start or stop measuring, and mirror the flag into the ref
   * the (mount-once) message handler reads.
   *
   * Blanking on the way OUT is what stops a stale number sitting frozen over
   * the viewport: reports stop arriving the moment the stage is told to stop,
   * so whatever was on screen would otherwise stay there, indistinguishable
   * from a real reading — and on the way back in it would flash that old value
   * for the ~250 ms before the first fresh report. Same reasoning as podest's
   * applyStats.
   */
  useEffect(() => {
    showStatsRef.current = showStats;
    if (statsRef.current) statsRef.current.textContent = showStats ? STATS_PLACEHOLDER : '';
    iframeRef.current?.contentWindow?.postMessage({ type: 'fs:stats-on', on: showStats }, '*');
  }, [showStats]);

  // A rebuild resets the chip to its placeholder for the same reason the anim
  // controls reset: the numbers on screen describe a document that no longer
  // exists. The re-arm itself rides fs:preview-ready, since the fresh
  // component isn't listening yet at this point.
  useEffect(() => {
    if (showStats && statsRef.current) statsRef.current.textContent = STATS_PLACEHOLDER;
  }, [previewHtml, showStats]);

  // The remembered playhead is only meaningful for the model it was measured
  // on, so it resets when the MODEL changes — not when the shader does, which
  // is the whole point of remembering it.
  useEffect(() => { animTimeRef.current = 0; animClipRef.current = 0; }, [geometryRebuildKey]);

  // A rebuild replaces the document the menu's anchor lives over; more to the
  // point, the new model may have a different clip list.
  useEffect(() => { setClipMenuOpen(false); }, [previewHtml]);

  // Hot-update channels: push appearance changes to the running iframe
  // instead of triggering an iframe rebuild. Idempotency is enforced on
  // the *iframe* side (each handler compares the payload to a last-
  // applied key seeded from the baked-in HTML state) rather than here,
  // because React StrictMode double-fires mount effects in dev — any
  // parent-side "skip first run" guard gets bypassed on the second fire,
  // so the iframe must be the safe one. See BRIDGE_SCRIPT_TEMPLATE in
  // tslToPreviewHTML.ts for the receivers.
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'fs:bg-color', color: bgColor },
      '*',
    );
  }, [bgColor]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'fs:lighting', lights: LIGHT_PRESETS[effLighting] ?? LIGHT_PRESETS.studio },
      '*',
    );
  }, [effLighting]);

  useEffect(() => {
    // from/to are computed in the parent so the iframe doesn't need to
    // know the plane-vs-other axis convention.
    const rawRot = rotationRef.current ?? { x: 0, y: 0, z: 0 };
    const mod360 = (v: number) => ((v % 360) + 360) % 360;
    const r = { x: mod360(rawRot.x), y: mod360(rawRot.y), z: mod360(rawRot.z) };
    const isPlane = geometry === 'plane';
    const from = `${r.x} ${r.y} ${r.z}`;
    const to = isPlane
      ? `${r.x} ${r.y} ${r.z + 360}`
      : `${r.x} ${r.y + 360} ${r.z}`;
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'fs:playing', playing, from, to },
      '*',
    );
  }, [playing, geometry]);

  // Live PRIMITIVE geometry + subdivision hot-swap. Any change that stays
  // entirely within primitives (sphere↔cube↔plane, or just a subdivision tweak)
  // is posted to the running iframe — the rebuild key (above) deliberately does
  // NOT rebuild for these. We skip only when a model (built-in OBJ or dropped
  // mesh) is involved on EITHER side: that crosses/triggers a rebuild which
  // bakes the new geometry, and posting a model swap to the live r184 WebGPU
  // scene is what crashes it. Both sides of the guard matter — a custom→sphere
  // switch with only the current-side checked would post a primitive attr into
  // the live model document.
  const prevGeometryRef = useRef(geometry);
  useEffect(() => {
    const prevWasModel = isModelGeometry(prevGeometryRef.current);
    prevGeometryRef.current = geometry;
    if (isModelGeometry(geometry) || prevWasModel) return;
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: 'fs:geometry',
        isObj: false,
        geometry: buildGeoAttr(
          geometry as 'sphere' | 'cube' | 'plane',
          effectiveSubdivision,
        ),
        rotation: GEOMETRY_ROTATIONS[geometry] ?? '45 45 0',
      },
      '*',
    );
  }, [geometry, effectiveSubdivision]);

  // OBJ model feed (see objTextCache above). By the iframe's load event its
  // top-level fs:obj-model listener is guaranteed installed (all preview
  // scripts are synchronous), so post-after-load can't lose the message —
  // same pattern as the fs:preview-ready→uniforms handshake. Runs on EVERY
  // load, so each geometry-rebuild iframe instance gets its model. The
  // message carries the geometry name and the iframe only accepts the model
  // it was built for, so a slow fetch resolving after a rapid teapot→bunny
  // switch can't apply a stale mesh to the newer document.
  const handleIframeLoad = useCallback(() => {
    if (!isModelGeometry(geometry)) return;
    if (geometry === 'custom') {
      // Dropped mesh: no fetch — post the stored payload. The exact
      // Uint8Array VIEW is posted (never `.buffer`, whose extent can differ)
      // and structured-cloned, so the store's copy stays live for the zip
      // export and every later rebuild. This copy happens once per iframe
      // rebuild (debounced 200ms), which is the price of a fresh document —
      // text formats are pre-decoded at load time (PreviewMesh.text).
      const mesh = previewMesh;
      const win = iframeRef.current?.contentWindow;
      if (!mesh || !win) return;
      const key = `custom:${mesh.id}`;
      if (mesh.kind === 'glb') {
        win.postMessage({ type: 'fs:obj-model', geometry: key, kind: 'glb', bytes: mesh.bytes }, '*');
      } else {
        win.postMessage({ type: 'fs:obj-model', geometry: key, kind: mesh.kind, text: mesh.text ?? '' }, '*');
      }
      return;
    }
    const geo = geometry as 'teapot' | 'bunny';
    fetchObjText(geo).then(
      (text) => {
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'fs:obj-model', geometry: geo, text },
          '*',
        );
      },
      (err: unknown) => {
        // Surface through the iframe's error overlay instead of failing
        // silently — the parent has no error surface of its own here.
        iframeRef.current?.contentWindow?.postMessage(
          {
            type: 'fs:obj-model-error',
            geometry: geo,
            message: err instanceof Error ? err.message : String(err),
          },
          '*',
        );
      },
    );
  }, [geometry, previewMesh]);

  // Immersive VR entry. Immersive WebXR can never start from the sandboxed
  // preview iframe — see the corrected rationale on PreviewOptions.xr in
  // tslToPreviewHTML.ts (it is NOT the Permissions-Policy layer; that one
  // `allow="xr-spatial-tracking *"` would pass) — so it starts from a
  // top-level page. An about:blank popup inherits this window's REAL origin,
  // so the local bundle URLs load, the OBJ models fetch same-origin (plain
  // obj-model url() — no message feed), and WebXR is permitted.
  // SECURITY: the popup runs the APP-GENERATED shader module — the same
  // safety-gated emission as the preview/export pipeline — at top level in
  // the app's real origin. That is acceptable for generated code; never
  // feed raw code-editor text into this path.
  // Blob URL for the custom mesh in the XR popup. The popup is same-origin,
  // so a parent-minted URL loads directly there. Revoked only when replaced —
  // an open popup may still be reading it, so leak-until-next-mint (bounded:
  // one URL) beats revoking under a live loader.
  const vrModelUrlRef = useRef<string | null>(null);
  const handleOpenVR = useCallback(() => {
    const w = window.open('', '_blank');
    if (!w) {
      window.alert('The browser blocked the VR window. Allow popups for this site and try again.');
      return;
    }
    let customModel: PreviewOptions['customModel'] = null;
    if (geometry === 'custom' && previewMesh) {
      if (vrModelUrlRef.current) {
        try { URL.revokeObjectURL(vrModelUrlRef.current); } catch { /* */ }
      }
      const blob = previewMesh.kind === 'glb'
        ? new Blob([previewMesh.bytes], { type: 'model/gltf-binary' })
        : new Blob([previewMesh.bytes]);
      vrModelUrlRef.current = URL.createObjectURL(blob);
      customModel = { kind: previewMesh.kind, id: previewMesh.id, url: vrModelUrlRef.current };
    }
    const html = tslToPreviewHTML(inlineImageAssetsFromNodes(previewCode, useAppStore.getState().nodes), {
      geometry,
      animate: playing,
      materialSettings,
      bgColor,
      lighting: effLighting,
      subdivision: effectiveSubdivision,
      customModel,
      initialCameraPosition: cameraPosRef.current,
      initialRotation: rotationRef.current,
      xr: true,
      title: shaderName,
    });
    w.document.write(html);
    w.document.close();
  }, [previewCode, geometry, previewMesh, playing, materialSettings, bgColor, effLighting, effectiveSubdivision, shaderName]);

  return (
    <div
      className="shader-preview"
      ref={rootRef}
      // Parent-side half of the drop surface (controls bar + overlays; the
      // iframe forwards its own region — see the fs:preview-drag handler).
      // Gated on the Files type so internal drags (palette tiles, node drags)
      // pass through untouched.
      onDragEnter={(e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        dragDepthRef.current++;
        refreshDropVeil();
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        refreshDropVeil();
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        if (--dragDepthRef.current < 0) dragDepthRef.current = 0;
        refreshDropVeil();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        dragDepthRef.current = 0;
        iframeDragRef.current = false;
        refreshDropVeil();
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length) handleDroppedFiles(files);
      }}
    >
      {/* The control bar SCROLLS rather than wrapping or clipping: the pane is
          user-resizable down to a couple of hundred px, and at that width the
          Light/Model/Subd controls and the WGSL/FPS/Uniforms group cannot all
          fit. Same treatment as the asset browser's two rows, through the same
          implementation (components/Layout/ScrollArrows.tsx) — including the
          wheel-to-horizontal mapping, since the bar is one line tall and a
          vertical wheel over it has nothing else to mean. */}
      <div className="shader-preview__ctl-wrap">
        {ctlArrows.canLeft && <ScrollArrow direction="left" onClick={() => ctlArrows.scrollBy(-1)} />}
      <div className="shader-preview__controls" ref={ctlRef}>
        <label className="shader-preview__ctl">
          <span className="shader-preview__ctl-label">{t('Light', language)}</span>
          <select
            className="shader-preview__geo-select"
            value={effLighting}
            onChange={(e) => setLighting(e.target.value as LightingMode)}
            title={t('Lighting mode', language)}
            aria-label={t('Lighting mode', language)}
          >
            <option value="studio">{t('Studio', language)}</option>
            <option value="moon">{t('Moon', language)}</option>
            <option value="laboratory">{t('Laboratory', language)}</option>
            {envMapName !== '' && (
              // Named after the attached environment image (extension
              // stripped) — selecting it turns the analytic lights off so the
              // map alone lights the model (material.envNode IBL).
              <option value="env">
                {envMapName === 'Environment'
                  ? t('Environment', language)
                  : truncateMiddle(envMapName.replace(/\.[^.]*$/, ''), 18)}
              </option>
            )}
          </select>
        </label>
        <label className="shader-preview__ctl">
          <span className="shader-preview__ctl-label">{t('Model', language)}</span>
          <select
            className="shader-preview__geo-select"
            value={geometry}
            onChange={(e) => setGeometry(e.target.value as GeometryType)}
            title={t('Preview geometry — drag the model to orbit, scroll to zoom; drop a 3D model (.obj / .glb / .gltf) on the preview to shade your own mesh', language)}
            aria-label={t('Preview geometry', language)}
          >
            <option value="sphere">{t('Sphere', language)}</option>
            <option value="cube">{t('Cube', language)}</option>
            <option value="plane">{t('Plane', language)}</option>
            <option value="teapot">{t('Utah Teapot', language)}</option>
            <option value="bunny">{t('Stanford Bunny', language)}</option>
            {previewMesh && (
              <option value="custom">{`${t('Model:', language)} ${truncateMiddle(previewMesh.name, 24)}`}</option>
            )}
          </select>
        </label>
        {!isModelGeometry(geometry) && (
          <label className="shader-preview__subdivision" title={t('Mesh subdivision', language)}>
            <span className="shader-preview__ctl-label">{t('Subd', language)}</span>
            <input
              type="range"
              min={SUBDIVISION_MIN}
              max={SUBDIVISION_MAX}
              step={1}
              value={subdivision}
              onChange={(e) => setSubdivision(parseInt(e.target.value, 10))}
              className="shader-preview__subdivision-slider"
            />
            <span className="shader-preview__subdivision-value">{subdivision}</span>
          </label>
        )}
        {/* Right-hand toggles. The group carries the auto margin, NOT the
            buttons: two `margin-left: auto` siblings SHARE the slack rather
            than stacking, so the pair would drift apart across the bar. */}
        <div className="shader-preview__ctl-right">
          {/* WGSL/GLSL backend toggle. The label is the backend the CURRENT
              document reported (a prediction only until the first report
              lands); active styling marks the FORCED state, so auto-GLSL on
              Safari reads as a fact, not a setting. */}
          <button
            type="button"
            className={`shader-preview__props-btn${forceWebGL2 ? ' shader-preview__props-btn--active' : ''}`}
            onClick={() => { if (backendLocked) return; setPreviewForceWebGL2(!forceWebGL2); }}
            aria-pressed={forceWebGL2}
            aria-disabled={backendLocked || undefined}
            // Stable accessible name: the visible WGSL/GLSL text flips with
            // state, and a flipping name beside aria-pressed reads as a
            // contradiction in a screen reader ("GLSL, not pressed" while
            // GLSL is exactly what runs). aria-label overrides text content
            // in the accessible-name computation; the title stays the
            // description.
            aria-label={t('Force the WebGL2 (GLSL) backend', language)}
            title={backendLocked
              ? t('WebGPU is not available in this browser — the preview always renders through WebGL2 (GLSL).', language)
              : forceWebGL2
                ? t('Forced to the WebGL2 (GLSL) backend — what the VR popup and Safari run. Click to return to WebGPU (WGSL).', language)
                : t('Rendering through WebGPU (WGSL). Click to force the WebGL2 (GLSL) backend — what the VR popup and Safari run — to check for backend-dependent differences.', language)}
          >
            {backendIsGlsl ? 'GLSL' : 'WGSL'}
          </button>
          <button
            type="button"
            className={`shader-preview__props-btn${showStats ? ' shader-preview__props-btn--active' : ''}`}
            onClick={() => setShowStats((v) => !v)}
            title={t('Frames per second and the time between presented frames, over the top-right corner. The period includes vsync, so it reads the display refresh rate until the shader actually misses frames.', language)}
            aria-pressed={showStats}
          >
            {t('FPS', language)}
          </button>
          {uniforms.length > 0 && (
            <button
              type="button"
              // The dot must survive a collapse: the overlay is collapsible, and
              // with it shut an override would have no affordance anywhere.
              className={`shader-preview__props-btn${showUniforms ? ' shader-preview__props-btn--active' : ''}${overrideCount ? ' shader-preview__props-btn--override' : ''}`}
              onClick={() => setShowUniforms((v) => !v)}
              title={showUniforms ? t('Hide uniforms', language) : t('Show uniforms', language)}
            >
              {t('Uniforms', language)}
            </button>
          )}
        </div>
      </div>
        {ctlArrows.canRight && <ScrollArrow direction="right" onClick={() => ctlArrows.scrollBy(1)} />}
      </div>
      <div className={`shader-preview__body${showStats ? ' shader-preview__body--stats' : ''}`} ref={bodyRef}>
        {compiling && (
          <div className="shader-preview__compiling" role="status" aria-live="polite">
            <span className="shader-preview__compiling-dot" />
            {t('Compiling shader…', language)}
          </div>
        )}
        {dropVeil && (
          <div className="shader-preview__drop-veil">
            {t('Drop a 3D model (.obj / .glb / .gltf) or a shader (.js / .zip)', language)}
          </div>
        )}
        {dropNotice && (
          <div className="shader-preview__drop-notice" role="alert">{dropNotice}</div>
        )}
        {/* Always MOUNTED while enabled (never conditionally rendered on the
            number), so the mount-once message handler can write into it via
            the ref without waiting for a React commit. */}
        {showStats && (
          <div className="shader-preview__stats" ref={statsRef} aria-live="off">
            {STATS_PLACEHOLDER}
          </div>
        )}
        <iframe
          ref={iframeRef}
          className="shader-preview__iframe"
          srcDoc={containerReady ? previewHtml : undefined}
          onLoad={handleIframeLoad}
          title={t('Shader Preview', language)}
          // User-pasted TSL becomes an ES module that runs inside this iframe.
          // Without sandboxing the iframe inherits the FastShaders origin and
          // would expose parent localStorage / cookies / same-origin fetch to
          // adversarial shader code. allow-scripts is the only flag granted;
          // omitting allow-same-origin puts the iframe in a unique opaque
          // origin so user code can't reach parent storage. We use srcDoc
          // (not src=blobUrl) because a parent-origin blob URL can't be
          // navigated into a foreign-origin sandboxed frame — srcdoc has no
          // origin of its own, so the content runs in the iframe's
          // sandbox-issued opaque origin from the start. Static parent
          // assets (OBJ models, A-Frame bundle) load via cross-origin
          // requests that depend on the server returning CORS headers — see
          // server.headers in vite.config.ts for the dev side; GitHub Pages
          // sets Access-Control-Allow-Origin: * on all served files.
          sandbox="allow-scripts"
          // Permissions Policy — both default to "denied" on sandboxed
          // frames; without these the browser's fullscreen overlay and any
          // A-Frame enter-VR button fail silently. The explicit `*` matters:
          // a bare feature name means the 'src' allowlist, which can never
          // match this srcdoc iframe's sandbox-issued OPAQUE origin — Safari
          // then reports "Fullscreen API is disabled by permissions policy".
          // fullscreen still needs a user gesture to take effect (the click
          // counts), so `*` doesn't open new attack surface beyond what
          // sandbox already permits. xr-spatial-tracking is the WebXR
          // feature flag; A-Frame probes for it on init regardless of
          // vr-mode-ui state. allowFullScreen is the legacy attribute some
          // WebKit paths still consult.
          allow="fullscreen *; xr-spatial-tracking *"
          allowFullScreen
        />
        {/* The bottom row, as ONE flex bar spanning the 3D view rather than two
            independently-anchored boxes. That is what lets the timeline stretch
            between the animation pill and the display cluster without measuring
            either of them — the two ends keep hugging their edges because the
            element between them takes the slack.

            The bar covers the full width, so it MUST NOT eat orbit drags in the
            gaps: it is pointer-events:none and its children opt back in. */}
        <div className="shader-preview__bottom-bar">
          {/* Bottom-LEFT playback/view cluster — floats over the 3D view (so it
              stays available in fullscreen): play/pause, background color, reset.
              The two "escape this pane" actions live in their own box at the
              bottom-right (below), so a mis-aimed click on the everyday controls
              can't throw the app into fullscreen or open a VR window. */}
          <div className="shader-preview__bottom-controls">
            {/* Only while the shader actually reads a mic uniform — the control
                must never advertise capture for a graph that doesn't listen.
                Leading position keeps it away from the destructive Reset ✕ that
                ends this cluster. */}
            {micUniformNames.length > 0 && (
              <MicControl
                status={mic.status}
                onArm={mic.arm}
                onDisarm={mic.disarm}
                meterRef={mic.meterRef}
                language={language}
              />
            )}
            <button
              className="shader-preview__play-btn"
              onClick={() => setPlaying((p) => !p)}
              title={playing ? t('Pause rotation', language) : t('Play rotation', language)}
              aria-label={playing ? t('Pause rotation', language) : t('Play rotation', language)}
            >
              {playing ? '⏸' : '▶'}
            </button>
            {/* `history="none"`: the scene backdrop is a PREVIEW PREFERENCE
                (`usePersistedState('fs:previewBgColor')`) — it never touches the
                graph, so bracketing would push an undo entry that restores
                nothing and wipe the redo stack on every pick. The popover follows
                this pane into fullscreen on its own (`pickPortalHost`). */}
            <PaletteColorPicker
              className="shader-preview__bg-color"
              history="none"
              value={bgColor}
              onPick={setBgColor}
              title={t('Background color', language)}
            />
            <button
              type="button"
              className="shader-preview__reset-btn"
              onClick={handleReset}
              title={t('Reset camera, lighting, subdivision, and uniform values to defaults', language)}
              aria-label={t('Reset', language)}
            >
              {'✕'}
            </button>
          </div>
          {/* The model's OWN animation, in its own box beside the view cluster —
              deliberately not folded in with the ▶ next door, which spins the
              turntable. Two different things called play; two different boxes.
              Present only while the loaded model actually carries a clip. */}
          {animInfo && (
            <div
              className="shader-preview__anim-controls"
              ref={animPillRef}
              // Right-click anywhere on the PILL, not just on the ▶. The
              // handler used to sit on the play button alone and be suppressed
              // below two clips, so a near-miss OR a single-clip file both fell
              // through to the browser's own menu — indistinguishable from the
              // feature not working. The ☰ button beside it is the primary,
              // visible path; this is the shortcut.
              onContextMenu={(e) => {
                e.preventDefault();
                // On Android/Quest Chromium a touch long-press ALSO synthesizes
                // a native contextmenu right as the 500ms timer fires — without
                // this window the toggle would close the menu the same gesture
                // just opened (an order-dependent flash).
                if (performance.now() - clipMenuTouchTsRef.current < 700) return;
                setClipMenuOpen((v) => !v);
              }}
            >
              <button
                type="button"
                className="shader-preview__anim-play"
                onClick={() => setAnimPlaying((p) => !p)}
                title={
                  `${animPlaying ? t('Pause model animation', language) : t('Play model animation', language)}` +
                  `${animInfo.name ? ` — ${animInfo.name}` : ''}` +
                  `${animInfo.clips.length > 1 ? ` (${animInfo.clip + 1}/${animInfo.clips.length})` : ''}`
                }
                aria-label={animPlaying ? t('Pause model animation', language) : t('Play model animation', language)}
              >
                {animPlaying ? '⏸' : '▶'}
              </button>
              {/* Toggle, not a pair of buttons: "off" is the same control
                  unlit. Disabled when the clip has no root translation to
                  remove — a live button that does nothing reads as broken. */}
              <button
                type="button"
                className={`shader-preview__anim-inplace${animInPlace && animInfo.canInPlace ? ' shader-preview__anim-inplace--active' : ''}`}
                onClick={() => setAnimInPlace((v) => !v)}
                disabled={!animInfo.canInPlace}
                aria-pressed={animInPlace && animInfo.canInPlace}
                title={
                  animInfo.canInPlace
                    ? (animInPlace
                        ? t('Playing in place — click to restore the animation’s own movement', language)
                        : t('Play in place: hold the model still and drop the animation’s root movement', language))
                    : t('This animation has no root movement to remove', language)
                }
              >
                ◎
              </button>
              {/* The clip list, as a plain visible button. Rendered whenever
                  there is an animation at all — NOT only for multi-clip files:
                  a control that appears on some models and not others is the
                  same "it doesn't work" failure the right-click gate caused,
                  and on a single-clip file the menu still answers a real
                  question (what is this clip called). */}
              <button
                type="button"
                ref={animClipsBtnRef}
                className={`shader-preview__anim-clips-btn${clipMenuOpen ? ' shader-preview__anim-clips-btn--active' : ''}`}
                onClick={() => setClipMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={clipMenuOpen}
                title={`${t('Animation clips', language)} (${animInfo.clips.length})`}
                aria-label={t('Animation clips', language)}
              >
                ☰
              </button>
              <AnimClipMenu
                anchor={animClipsBtnRef.current}
                dismissExempt={animPillRef.current}
                open={clipMenuOpen}
                clips={animInfo.clips}
                active={animInfo.clip}
                onPick={selectClip}
                onClose={() => setClipMenuOpen(false)}
                language={language}
              />
            </div>
          )}
          {/* The scrubber. Stretches between the animation pill and the display
              cluster; when there is no animation it isn't rendered at all and
              the display cluster's `margin-left: auto` keeps the right edge. */}
          {animInfo && (
            <div
              className="shader-preview__timeline"
              ref={timelineRef}
              role="slider"
              tabIndex={0}
              aria-label={t('Animation timeline', language)}
              aria-valuemin={0}
              aria-valuemax={animInfo.duration}
              aria-valuenow={animTimeRef.current}
              onPointerDown={(e) => {
                // Capture on the TRACK, never on the thumb: the thumb is moved
                // by an imperative style write on every report, and a pointer
                // captured by an element the gesture keeps repositioning is the
                // classic way to lose a drag halfway across. Throw-safe like
                // the release below — a pointer can be inactive by dispatch
                // time (fast pen lift), and the seek must still run.
                try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* already gone */ }
                scrubbingRef.current = true;
                seekAnim(timeFromPointer(e.clientX));
              }}
              onPointerMove={(e) => {
                if (!scrubbingRef.current) return;
                seekAnim(timeFromPointer(e.clientX));
              }}
              onPointerUp={(e) => {
                scrubbingRef.current = false;
                try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
              }}
              onPointerCancel={() => { scrubbingRef.current = false; }}
              onKeyDown={(e) => {
                // Arrow keys step 1/50th of the clip; Home/End jump the ends.
                const dur = animInfo.duration;
                const step = dur / 50;
                let next: number | null = null;
                if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = animTimeRef.current + step;
                else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = animTimeRef.current - step;
                else if (e.key === 'Home') next = 0;
                else if (e.key === 'End') next = dur;
                if (next === null) return;
                e.preventDefault();
                seekAnim(Math.max(0, Math.min(dur, next)));
              }}
            >
              <div className="shader-preview__timeline-line" />
              <div className="shader-preview__timeline-thumb" ref={thumbRef} />
            </div>
          )}
          {/* Bottom-RIGHT display cluster: the two ways to hand the shader a
              bigger screen. Fullscreen and VR are the same idea one step apart
              (fill this display / fill your headset), and the XR page's own gate
              button already collapses to Fullscreen where WebXR is absent. */}
          <div className="shader-preview__display-controls">
            {/* Hidden on desktop: the Tauri app has the LAN "VR" bench flow in
                the toolbar, and window.open in its webview isn't this feature's
                target. */}
            {!__FS_DESKTOP__ && (
              <button
                type="button"
                className="shader-preview__vr-btn"
                onClick={handleOpenVR}
                title={t('Open this shader in a new window and enter immersive VR, with a frame-time / FPS readout in view (WebXR requires a top-level page)', language)}
              >
                VR
              </button>
            )}
            <button
              type="button"
              className="shader-preview__fs-btn"
              onClick={handleToggleFullscreen}
              title={isFullscreen ? t('Exit fullscreen', language) : t('Fullscreen preview', language)}
              aria-label={isFullscreen ? t('Exit fullscreen', language) : t('Fullscreen preview', language)}
            >
              {/* Distinct exit glyph — never '✕', which would twin with the red
                  Reset ✕ in the cluster next door while fullscreen. */}
              {isFullscreen ? '⤡' : '⛶'}
            </button>
          </div>
        </div>
        {uniforms.length > 0 && showUniforms && (
          <div className="shader-preview__uniforms">
            {/* '*' means the graph has no property nodes at all (hand-written
                TSL), so there is nothing in the graph to write back to. */}
            {connectedPropNamesKey !== ALL_UNIFORMS && (
              <button
                type="button"
                // Highlighted while anything is overridden: this is the one
                // path that makes a tuned value durable and agreed-on across
                // the node card, the Output tab and the exported .js.
                className={`shader-preview__uniforms-default-btn${overrideCount ? ' shader-preview__uniforms-default-btn--active' : ''}`}
                onClick={handleSetDefaults}
                title={t('Bake the values below into the graph as the shader’s defaults. Recompiles the preview. Slider min/max stay a preview setting — the graph has no field for them.', language)}
              >
                {t('Set as default', language)}{overrideCount ? ` (${overrideCount})` : ''}
              </button>
            )}
            {uniforms.map((u) => {
              const raw = uniformValues[u.name] ?? u.defaultValue;
              // The chip carries the GRAPH's number while the row's own value
              // carries the PREVIEW's, so each shows the one the other hides.
              // Without it a tuned value simply won, silently, and the number
              // on the property node looked broken.
              const over = isOverridden(u, uniformValues[u.name]);
              // The GRAPH's number rides the revert button's tooltip while the
              // row's own value carries the PREVIEW's, so each still surfaces
              // the one the other hides — the reason the old inline chip
              // printed it. It moved into the title when the affordance became
              // an icon button parked at the end of the controls row.
              const graphText =
                u.kind === 'color' ? String(u.defaultValue) : Number(u.defaultValue).toFixed(3);
              // Rendered on EVERY row, not just overridden ones: a control that
              // appears and disappears reflows the whole row (the slider track
              // would resize under the pointer mid-drag) and gives the user no
              // stable target to aim at. Disabled is the resting state; the red
              // fill is what says "this row is not showing the graph".
              const revertBtn = (
                <button
                  type="button"
                  className={`shader-preview__uniform-revert${over ? ' shader-preview__uniform-revert--active' : ''}`}
                  onClick={() => revertUniform(u.name)}
                  disabled={!over || u.unparsed}
                  aria-label={t('Reset to graph value', language)}
                  title={
                    over
                      ? `${t('Preview is running your tuned value, not the graph’s', language)} (${t('graph', language)} ${graphText}). ${t('Click to use the graph value.', language)}`
                      : `${t('Matches the graph value', language)} (${graphText})`
                  }
                >
                  ↺
                </button>
              );
              // Colour uniform: a swatch picker row — bounds/slider are
              // meaningless for a colour, so the row is just name + picker.
              // Branching BEFORE any bounds computation matters: every colour
              // row used to install a junk {0,1} seed entry, and the property
              // name field commits per keystroke, so renaming one walked a
              // fresh entry in for every prefix.
              if (u.kind === 'color') {
                const hex = typeof raw === 'string' ? raw : String(u.defaultValue);
                return (
                  <div key={u.name} className="shader-preview__uniform-row">
                    <div className="shader-preview__uniform-header">
                      <span className="shader-preview__uniform-name" title={u.name}>{u.name}</span>
                      <span className={`shader-preview__uniform-value${over ? ' shader-preview__uniform-value--override' : ''}`}>{hex}</span>
                    </div>
                    <div className="shader-preview__uniform-controls">
                      {/* `history="none"`: a live uniform is NOT graph state.
                          `handleUniformChange` sets overlay-local state and
                          posts `fs:uniform` into the iframe; the value persists
                          BY NAME in `fs:previewUniformValues`, and "Set as
                          default" is the separate, explicit write-back that
                          bakes it into the property nodes. Bracketing here
                          would push an undo entry that restores nothing and
                          clear the redo stack on every drag of a colour.

                          Exactly ONE grid child, like the input it replaces:
                          the popover is a portal, so it is not a child of this
                          row at all. The controls row is
                          `32px 1fr 32px auto` and this button keeps
                          `grid-column: 1 / -2`, leaving the last track for the
                          revert button — a fifth child here would wrap. */}
                      <PaletteColorPicker
                        className="shader-preview__uniform-color"
                        history="none"
                        value={hex}
                        onPick={(next) => handleUniformChange(u.name, next)}
                      />
                      {/* A colour row has no min/max, so "right of the max"
                          resolves to the end of the controls row — the same
                          screen position the float rows put it in. */}
                      {revertBtn}
                    </div>
                  </div>
                );
              }
              const value = typeof raw === 'number' ? raw : Number(u.defaultValue) || 0;
              // Frozen fallback bounds are kept only while they still CONTAIN
              // the displayed value: the ↺ revert, Reset and a node edit all
              // move that value without touching the authored default, and a
              // stale seed would print the true number against a track that
              // cannot reach it — the first touch would then clamp the number
              // away and store the clamp.
              const bounds =
                uniformBounds[u.name]
                ?? (seededBoundsRef.current[u.name] =
                      fallbackBounds(seededBoundsRef.current[u.name], value));
              const span = bounds.max - bounds.min;
              const step = span > 0 ? span / 200 : 0.01;
              return (
                <div key={u.name} className="shader-preview__uniform-row">
                  <div className="shader-preview__uniform-header">
                    <span className="shader-preview__uniform-name" title={u.name}>{u.name}</span>
                    <span className={`shader-preview__uniform-value${over ? ' shader-preview__uniform-value--override' : ''}`}>{value.toFixed(3)}</span>
                  </div>
                  <div className="shader-preview__uniform-controls">
                    <BoundInput
                      className="shader-preview__uniform-bound"
                      value={bounds.min}
                      onCommit={(n) => handleBoundsChange(u.name, 'min', n)}
                      title={t('Min', language)}
                    />
                    <input
                      type="range"
                      className="shader-preview__uniform-slider"
                      min={bounds.min}
                      max={bounds.max}
                      step={step}
                      value={value}
                      onChange={(e) => handleUniformChange(u.name, parseFloat(e.target.value))}
                    />
                    <BoundInput
                      className="shader-preview__uniform-bound"
                      value={bounds.max}
                      onCommit={(n) => handleBoundsChange(u.name, 'max', n)}
                      title={t('Max', language)}
                    />
                    {revertBtn}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
