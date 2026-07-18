import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { getNodeValues } from '@/types';
import { usePersistedState } from '@/hooks/usePersistedState';
import {
  GEOMETRY_ROTATIONS,
  LIGHT_PRESETS,
  buildGeoAttr,
  getModelUrl,
  isObjGeometry,
  tslToPreviewHTML,
} from '@/engine/tslToPreviewHTML';
import type { CameraPosition, GeometryType, LightingMode, PreviewOptions } from '@/engine/tslToPreviewHTML';
import './ShaderPreview.css';

interface UniformInfo {
  name: string;
  kind: 'float' | 'color';
  /** float → number; color → '#rrggbb' hex string. */
  defaultValue: number | string;
}

/** A persistable uniform value: finite number (float) or '#rrggbb' (colour). */
function isValidUniformValue(v: unknown): v is number | string {
  return (
    (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v))
  );
}

interface UniformBounds {
  min: number;
  max: number;
}

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
  return 'sphere';
}

function validateLighting(v: string | null): LightingMode {
  if (v === 'studio' || v === 'moon' || v === 'laboratory') return v;
  return 'studio';
}

// bgColor is concatenated into the preview iframe HTML (`background="color:
// ${bgColor}"`). An imported project file controls it via fs:previewBgColor,
// so — like geometry/lighting above — it must be validated before use or a
// payload like `red"></a-scene><img src=x onerror=…>` would inject markup.
// Accept only hex, rgb()/rgba() with numeric content, or a bare CSS color
// keyword (letters only — no spaces/quotes/brackets to break out with).
const DEFAULT_BG_COLOR = '#808080';
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

/**
 * Drop dangerous structural keys when parsing localStorage. Same rationale
 * as the reviver in useAppStore — defense in depth against a tampered
 * `fs:previewCameraPos` / `fs:previewRotation` / `fs:previewUniformBounds`
 * smuggling `__proto__` etc. into the parsed object.
 */
function safeJsonReviver(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
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

function validateUniformBounds(raw: string | null): Record<string, UniformBounds> {
  if (raw) {
    const parsed = JSON.parse(raw, safeJsonReviver);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, UniformBounds>;
  }
  return {};
}

function validateUniformValues(raw: string | null): Record<string, number | string> {
  if (raw) {
    const parsed = JSON.parse(raw, safeJsonReviver);
    if (parsed && typeof parsed === 'object') {
      const result: Record<string, number | string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (isValidUniformValue(v)) result[k] = v;
      }
      return result;
    }
  }
  return {};
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
 * Extract scalar property uniforms from generated TSL code by matching
 * `const NAME = uniform(VALUE)` — the same pattern the shaderloader auto-detects.
 * This guarantees the names we render in the overlay match the keys the
 * shaderloader uses for `_propertyUniforms`, regardless of any mangling
 * graphToCode does to the original property name.
 */
function extractUniforms(code: string): UniformInfo[] {
  const result: UniformInfo[] = [];
  const seen = new Set<string>();
  // Colour pass FIRST: the numeric regex's `[^)]+` stops at the first ')', so
  // it also matches `uniform(color(0xff0000)` with a garbage capture — colour
  // names must be claimed before the numeric pass sees them. Same ordering rule
  // as the shaderloader's autoDetectSchema.
  const colorRegex = /\bconst\s+(\w+)\s*=\s*uniform\(\s*color\(\s*0x([0-9a-fA-F]{6})\s*\)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = colorRegex.exec(code)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    result.push({ name, kind: 'color', defaultValue: `#${m[2].toLowerCase()}` });
  }
  const regex = /\bconst\s+(\w+)\s*=\s*uniform\(\s*([^)]+)\s*\)/g;
  while ((m = regex.exec(code)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const val = parseFloat(m[2]);
    result.push({ name, kind: 'float', defaultValue: isNaN(val) ? 0 : val });
  }
  return result;
}

export function ShaderPreview() {
  const previewCode = useAppStore((s) => s.previewCode);
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const shaderName = useAppStore((s) => s.shaderName);
  const language = useAppStore((s) => s.language);

  // Read material settings from the output node
  const outputNode = nodes.find((n) => n.data.registryType === 'output');
  const materialSettings = (outputNode?.data as { materialSettings?: PreviewOptions['materialSettings'] })?.materialSettings;

  // All preview prefs re-read on `fs:project-imported` — a project file
  // carries them, and the overlay + iframe srcDoc inputs must pick up the
  // imported values without a page reload.
  const [geometry, setGeometry] = usePersistedState('fs:previewGeometry', validateGeometry, { reloadOnProjectImport: true });
  const [playing, setPlaying] = usePersistedState('fs:previewPlaying', validatePlaying, { reloadOnProjectImport: true });
  const [lighting, setLighting] = usePersistedState('fs:previewLighting', validateLighting, { reloadOnProjectImport: true });
  const [subdivision, setSubdivision] = usePersistedState('fs:previewSubdivision', validateSubdivision, { reloadOnProjectImport: true });
  const [bgColor, setBgColor] = usePersistedState('fs:previewBgColor', validateBgColor, { reloadOnProjectImport: true });

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
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
  const cameraPosRef = useRef<CameraPosition | null>(loadCameraPos());
  const rotationRef = useRef<CameraPosition | null>(loadRotation());

  // Property uniforms detected from the generated code, filtered to only those
  // whose property node has at least one outgoing edge (i.e. is connected).
  // BOTH property kinds must be scanned: with only property_float here, the
  // presence of one float property made the connected-names set float-only and
  // silently filtered every colour picker out of the overlay.
  const uniforms = useMemo(() => {
    const all = extractUniforms(previewCode);
    // If no property nodes exist (e.g. direct-assignment mode), show all
    const propertyNodes = nodes.filter(
      (n) => n.data.registryType === 'property_float' || n.data.registryType === 'property_color',
    );
    if (propertyNodes.length === 0) return all;
    // Build set of connected property node IDs (have at least one outgoing edge)
    const connectedIds = new Set<string>();
    for (const e of edges) {
      if (propertyNodes.some((n) => n.id === e.source)) {
        connectedIds.add(e.source);
      }
    }
    // Map connected IDs to their variable names (values.name)
    const connectedNames = new Set<string>();
    for (const n of propertyNodes) {
      if (connectedIds.has(n.id)) {
        const name = getNodeValues(n).name;
        if (name != null && name !== '') connectedNames.add(String(name));
      }
    }
    return all.filter((u) => connectedNames.has(u.name));
  }, [previewCode, nodes, edges]);

  // Per-uniform min/max — persisted across reloads, keyed by uniform name
  const [showUniforms, setShowUniforms] = useState(true);
  const [uniformBounds, setUniformBounds] = usePersistedState('fs:previewUniformBounds', validateUniformBounds, { serialize: JSON.stringify, reloadOnProjectImport: true });

  // Live slider values — overlay-local (don't write back to the graph, so
  // tweaking a slider doesn't trigger a graph re-sync and tear the iframe
  // down) but persisted to localStorage so refresh + node-graph mutations
  // (rename/delete/re-add of a property node) preserve user tuning, the
  // same way uniformBounds and camera/rotation already do.
  const [uniformValues, setUniformValues] = usePersistedState('fs:previewUniformValues', validateUniformValues, { serialize: JSON.stringify, reloadOnProjectImport: true });
  // When the set of uniform names changes, seed any newly-appearing entries
  // from their code-side default. Existing entries (including ones that
  // disappeared earlier and have just come back via undo/rename/re-add) keep
  // their stored value — we deliberately do NOT prune names that aren't in
  // the current shader, mirroring uniformBounds' "remember everything"
  // behaviour. The iframe's fs:uniform handler ignores unknown names, so
  // carrying extras is harmless.
  const uniformsKey = uniforms.map((u) => `${u.name}=${u.defaultValue}`).join('|');
  useEffect(() => {
    setUniformValues((prev) => {
      let changed = false;
      const next: Record<string, number | string> = { ...prev };
      for (const u of uniforms) {
        if (!(u.name in prev)) {
          next[u.name] = u.defaultValue;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniformsKey]);

  // Refs for the message handler so it doesn't need to re-bind on every change
  const uniformValuesRef = useRef(uniformValues);
  const uniformKindsRef = useRef<Map<string, 'float' | 'color'>>(new Map());
  useEffect(() => {
    uniformKindsRef.current = new Map(uniforms.map((u) => [u.name, u.kind]));
  }, [uniforms]);
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
      const data = e.data as { type?: string; x?: number; y?: number; z?: number } | null;
      if (!data || typeof data.type !== 'string') return;
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
          // otherwise. Names not in the current shader still pass through
          // unchanged (the iframe ignores unknown names).
          const kind = uniformKindsRef.current.get(name);
          if (kind && typeof value !== (kind === 'color' ? 'string' : 'number')) continue;
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

    // Property uniforms back to their shader defaults. Update local state so
    // the overlay reflects the change, AND push to the iframe immediately
    // (the rebuild path's fs:preview-ready handler is a safety net for the
    // case where lighting/subdivision did trigger a rebuild).
    const defaults: Record<string, number | string> = {};
    for (const u of uniforms) {
      defaults[u.name] = u.defaultValue;
      win?.postMessage({ type: 'fs:uniform', name: u.name, value: u.defaultValue }, '*');
    }
    setUniformValues(defaults);
  }, [uniforms]);

  // Slider drag / colour pick → live uniform update via postMessage
  const handleUniformChange = useCallback((name: string, value: number | string) => {
    setUniformValues((prev) => ({ ...prev, [name]: value }));
    iframeRef.current?.contentWindow?.postMessage({ type: 'fs:uniform', name, value }, '*');
  }, []);

  const handleBoundsChange = useCallback((name: string, key: 'min' | 'max', value: number) => {
    setUniformBounds((prev) => {
      const current = prev[name] ?? { min: 0, max: 1 };
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

  // OBJ-backed geometries ignore the subdivision slider entirely. Folding the
  // value to a constant in the dep list (instead of the live state) means
  // dragging the slider while a teapot/bunny is selected doesn't rebuild the
  // iframe to produce identical HTML.
  const effectiveSubdivision = isObjGeometry(geometry) ? 0 : subdivision;

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

  const geometryRebuildKey = isObjGeometry(geometry) ? geometry : '__primitive__';
  const previewHtml = useMemo(() => {
    const options: PreviewOptions = {
      geometry,
      animate: playing,
      materialSettings,
      bgColor,
      lighting,
      subdivision: effectiveSubdivision,
      // Read from the ref at memo time so the user's current camera angle
      // survives setting changes (subdivision, lighting, etc.) without
      // joining the dep list (which would cause an infinite rebuild loop).
      initialCameraPosition: cameraPosRef.current,
      initialRotation: rotationRef.current,
    };
    return tslToPreviewHTML(debouncedPreviewCode, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedPreviewCode, materialSettings, geometryRebuildKey]);

  // A new srcDoc means a full document reload, so raise the overlay again. Only
  // rebuilds go through here — the postMessage hot-update channels below mutate
  // the live scene and must NOT flash it.
  useEffect(() => {
    if (!containerReady) return;
    setCompiling(true);
    const id = setTimeout(() => setCompiling(false), COMPILE_OVERLAY_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [previewHtml, containerReady]);

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
      { type: 'fs:lighting', lights: LIGHT_PRESETS[lighting] ?? LIGHT_PRESETS.studio },
      '*',
    );
  }, [lighting]);

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
  // NOT rebuild for these. We skip only when an OBJ model is involved on either
  // side: that crosses/triggers a rebuild which bakes the new geometry, and
  // posting an OBJ swap to the live r184 WebGPU scene is what crashes it.
  const prevGeometryRef = useRef(geometry);
  useEffect(() => {
    const prevWasObj = isObjGeometry(prevGeometryRef.current);
    prevGeometryRef.current = geometry;
    if (isObjGeometry(geometry) || prevWasObj) return;
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
    if (!isObjGeometry(geometry)) return;
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
  }, [geometry]);

  // Immersive VR entry. Permissions-Policy can never delegate
  // xr-spatial-tracking to the sandboxed preview iframe's OPAQUE origin —
  // immersive WebXR must start from a top-level page. An about:blank popup
  // inherits this window's REAL origin, so the local bundle URLs load, the
  // OBJ models fetch same-origin (plain obj-model url() — no message feed),
  // and WebXR is permitted.
  // SECURITY: the popup runs the APP-GENERATED shader module — the same
  // safety-gated emission as the preview/export pipeline — at top level in
  // the app's real origin. That is acceptable for generated code; never
  // feed raw code-editor text into this path.
  const handleOpenVR = useCallback(() => {
    const w = window.open('', '_blank');
    if (!w) {
      window.alert('The browser blocked the VR window. Allow popups for this site and try again.');
      return;
    }
    const html = tslToPreviewHTML(previewCode, {
      geometry,
      animate: playing,
      materialSettings,
      bgColor,
      lighting,
      subdivision: effectiveSubdivision,
      initialCameraPosition: cameraPosRef.current,
      initialRotation: rotationRef.current,
      xr: true,
      title: shaderName,
    });
    w.document.write(html);
    w.document.close();
  }, [previewCode, geometry, playing, materialSettings, bgColor, lighting, effectiveSubdivision, shaderName]);

  return (
    <div className="shader-preview" ref={rootRef}>
      <div className="shader-preview__controls">
        <button
          className="shader-preview__play-btn"
          onClick={() => setPlaying((p) => !p)}
          title={playing ? t('Pause rotation', language) : t('Play rotation', language)}
          aria-label={playing ? t('Pause rotation', language) : t('Play rotation', language)}
        >
          {playing ? '\u23F8' : '\u25B6'}
        </button>
        <button
          type="button"
          className="shader-preview__fs-btn"
          onClick={handleToggleFullscreen}
          title={isFullscreen ? t('Exit fullscreen', language) : t('Fullscreen preview', language)}
          aria-label={isFullscreen ? t('Exit fullscreen', language) : t('Fullscreen preview', language)}
        >
          {isFullscreen ? '\u2715' : '\u26F6'}
        </button>
        <button
          type="button"
          className="shader-preview__reset-btn"
          onClick={handleReset}
          title={t('Reset camera, lighting, subdivision, and uniform values to defaults', language)}
        >
          {t('Reset', language)}
        </button>
        {/* Hidden on desktop: the Tauri app has the LAN "VR" bench flow in
            the toolbar, and window.open in its webview isn't this feature's
            target. */}
        {!__FS_DESKTOP__ && (
          <button
            type="button"
            className="shader-preview__vr-btn"
            onClick={handleOpenVR}
            title={t('Open this shader in a new window with an Enter-VR button (WebXR requires a top-level page)', language)}
          >
            VR
          </button>
        )}
        <input
          type="color"
          className="shader-preview__bg-color"
          value={bgColor}
          onChange={(e) => setBgColor(e.target.value)}
          title={t('Background color', language)}
          aria-label={t('Preview background color', language)}
        />
        <select
          className="shader-preview__geo-select"
          value={lighting}
          onChange={(e) => setLighting(e.target.value as LightingMode)}
          title={t('Lighting mode', language)}
          aria-label={t('Lighting mode', language)}
        >
          <option value="studio">{t('light: Studio', language)}</option>
          <option value="moon">{t('light: Moon', language)}</option>
          <option value="laboratory">{t('light: Laboratory', language)}</option>
        </select>
        <select
          className="shader-preview__geo-select"
          value={geometry}
          onChange={(e) => setGeometry(e.target.value as GeometryType)}
          title={t('Preview geometry — drag the model to orbit, scroll to zoom', language)}
          aria-label={t('Preview geometry', language)}
        >
          <option value="sphere">{t('Sphere', language)}</option>
          <option value="cube">{t('Cube', language)}</option>
          <option value="plane">{t('Plane', language)}</option>
          <option value="teapot">{t('Utah Teapot', language)}</option>
          <option value="bunny">{t('Stanford Bunny', language)}</option>
        </select>
        {!isObjGeometry(geometry) && (
          <label className="shader-preview__subdivision" title={t('Mesh subdivision', language)}>
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
        {uniforms.length > 0 && (
          <button
            type="button"
            className={`shader-preview__props-btn${showUniforms ? ' shader-preview__props-btn--active' : ''}`}
            onClick={() => setShowUniforms((v) => !v)}
            title={showUniforms ? t('Hide properties', language) : t('Show properties', language)}
          >
            {t('Properties', language)}
          </button>
        )}
      </div>
      <div className="shader-preview__body" ref={bodyRef}>
        {compiling && (
          <div className="shader-preview__compiling" role="status" aria-live="polite">
            <span className="shader-preview__compiling-dot" />
            {t('Compiling shader…', language)}
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
        {uniforms.length > 0 && showUniforms && (
          <div className="shader-preview__uniforms">
            {uniforms.map((u) => {
              const bounds = uniformBounds[u.name] ?? { min: 0, max: 1 };
              const raw = uniformValues[u.name] ?? u.defaultValue;
              // Colour uniform: a swatch picker row — bounds/slider are
              // meaningless for a colour, so the row is just name + picker.
              if (u.kind === 'color') {
                const hex = typeof raw === 'string' ? raw : String(u.defaultValue);
                return (
                  <div key={u.name} className="shader-preview__uniform-row">
                    <div className="shader-preview__uniform-header">
                      <span className="shader-preview__uniform-name" title={u.name}>{u.name}</span>
                      <span className="shader-preview__uniform-value">{hex}</span>
                    </div>
                    <div className="shader-preview__uniform-controls">
                      <input
                        type="color"
                        className="shader-preview__uniform-color"
                        value={hex}
                        onChange={(e) => handleUniformChange(u.name, e.target.value)}
                      />
                    </div>
                  </div>
                );
              }
              const value = typeof raw === 'number' ? raw : Number(u.defaultValue) || 0;
              const span = bounds.max - bounds.min;
              const step = span > 0 ? span / 200 : 0.01;
              return (
                <div key={u.name} className="shader-preview__uniform-row">
                  <div className="shader-preview__uniform-header">
                    <span className="shader-preview__uniform-name" title={u.name}>{u.name}</span>
                    <span className="shader-preview__uniform-value">{value.toFixed(3)}</span>
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
