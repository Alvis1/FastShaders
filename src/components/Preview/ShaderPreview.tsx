import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { getNodeValues } from '@/types';
import {
  GEOMETRY_ROTATIONS,
  LIGHT_PRESETS,
  buildGeoAttr,
  isObjGeometry,
  tslToPreviewHTML,
} from '@/engine/tslToPreviewHTML';
import type { CameraPosition, GeometryType, LightingMode, PreviewOptions } from '@/engine/tslToPreviewHTML';
import './ShaderPreview.css';

interface UniformInfo {
  name: string;
  defaultValue: number;
}

interface UniformBounds {
  min: number;
  max: number;
}

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

function loadGeometry(): GeometryType {
  try {
    const v = localStorage.getItem('fs:previewGeometry');
    if (v === 'cube' || v === 'plane' || v === 'sphere' || v === 'teapot' || v === 'bunny') return v;
  } catch { /* */ }
  return 'sphere';
}

function loadLighting(): LightingMode {
  try {
    const v = localStorage.getItem('fs:previewLighting');
    if (v === 'studio' || v === 'moon' || v === 'laboratory') return v;
  } catch { /* */ }
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
function loadBgColor(): string {
  try {
    const v = localStorage.getItem('fs:previewBgColor');
    if (v && isValidCssColor(v)) return v;
  } catch { /* */ }
  return DEFAULT_BG_COLOR;
}

const SUBDIVISION_MIN = 1;
const SUBDIVISION_MAX = 256;
const SUBDIVISION_DEFAULT = 64;

function loadSubdivision(): number {
  try {
    const v = parseInt(localStorage.getItem('fs:previewSubdivision') ?? '', 10);
    if (!isNaN(v) && v >= SUBDIVISION_MIN && v <= SUBDIVISION_MAX) return v;
  } catch { /* */ }
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

function loadCameraPos(): CameraPosition | null {
  try {
    const raw = localStorage.getItem('fs:previewCameraPos');
    if (raw) {
      const p = JSON.parse(raw, safeJsonReviver);
      if (p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') {
        // Reject origin-ish values — a prior bug saved (0,0,0) every frame by
        // reading the camera-entity wrapper instead of the camera itself.
        // Restoring that would place the camera inside the mesh.
        if (Math.hypot(p.x, p.y, p.z) < 1) {
          try { localStorage.removeItem('fs:previewCameraPos'); } catch { /* */ }
          return null;
        }
        return { x: p.x, y: p.y, z: p.z };
      }
    }
  } catch { /* */ }
  return null;
}

function loadRotation(): CameraPosition | null {
  try {
    const raw = localStorage.getItem('fs:previewRotation');
    if (raw) {
      const p = JSON.parse(raw, safeJsonReviver);
      if (p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') {
        return { x: p.x, y: p.y, z: p.z };
      }
    }
  } catch { /* */ }
  return null;
}

function loadPlaying(): boolean {
  try { return localStorage.getItem('fs:previewPlaying') === 'true'; } catch { return false; }
}

function loadUniformBounds(): Record<string, UniformBounds> {
  try {
    const raw = localStorage.getItem('fs:previewUniformBounds');
    if (raw) {
      const parsed = JSON.parse(raw, safeJsonReviver);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, UniformBounds>;
    }
  } catch { /* */ }
  return {};
}

function loadUniformValues(): Record<string, number> {
  try {
    const raw = localStorage.getItem('fs:previewUniformValues');
    if (raw) {
      const parsed = JSON.parse(raw, safeJsonReviver);
      if (parsed && typeof parsed === 'object') {
        const result: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isFinite(v)) result[k] = v;
        }
        return result;
      }
    }
  } catch { /* */ }
  return {};
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
  const regex = /\bconst\s+(\w+)\s*=\s*uniform\(\s*([^)]+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(code)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const val = parseFloat(m[2]);
    result.push({ name, defaultValue: isNaN(val) ? 0 : val });
  }
  return result;
}

export function ShaderPreview() {
  const previewCode = useAppStore((s) => s.previewCode);
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);

  // Read material settings from the output node
  const outputNode = nodes.find((n) => n.data.registryType === 'output');
  const materialSettings = (outputNode?.data as { materialSettings?: PreviewOptions['materialSettings'] })?.materialSettings;

  const [geometry, setGeometry] = useState<GeometryType>(loadGeometry);
  const [playing, setPlaying] = useState<boolean>(loadPlaying);
  const [lighting, setLighting] = useState<LightingMode>(loadLighting);
  const [subdivision, setSubdivision] = useState<number>(loadSubdivision);
  const [bgColor, setBgColor] = useState(loadBgColor);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

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
  // whose property_float node has at least one outgoing edge (i.e. is connected).
  const uniforms = useMemo(() => {
    const all = extractUniforms(previewCode);
    // If no property nodes exist (e.g. direct-assignment mode), show all
    const propertyNodes = nodes.filter((n) => n.data.registryType === 'property_float');
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
  const [uniformBounds, setUniformBounds] = useState<Record<string, UniformBounds>>(loadUniformBounds);
  useEffect(() => {
    try { localStorage.setItem('fs:previewUniformBounds', JSON.stringify(uniformBounds)); } catch { /* */ }
  }, [uniformBounds]);

  // Live slider values — overlay-local (don't write back to the graph, so
  // tweaking a slider doesn't trigger a graph re-sync and tear the iframe
  // down) but persisted to localStorage so refresh + node-graph mutations
  // (rename/delete/re-add of a property node) preserve user tuning, the
  // same way uniformBounds and camera/rotation already do.
  const [uniformValues, setUniformValues] = useState<Record<string, number>>(loadUniformValues);
  useEffect(() => {
    try { localStorage.setItem('fs:previewUniformValues', JSON.stringify(uniformValues)); } catch { /* */ }
  }, [uniformValues]);
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
      const next: Record<string, number> = { ...prev };
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
      if (data.type === 'fs:preview-ready') {
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
    const defaults: Record<string, number> = {};
    for (const u of uniforms) {
      defaults[u.name] = u.defaultValue;
      win?.postMessage({ type: 'fs:uniform', name: u.name, value: u.defaultValue }, '*');
    }
    setUniformValues(defaults);
  }, [uniforms]);

  // Slider drag → live uniform update via postMessage
  const handleUniformChange = useCallback((name: string, value: number) => {
    setUniformValues((prev) => ({ ...prev, [name]: value }));
    iframeRef.current?.contentWindow?.postMessage({ type: 'fs:uniform', name, value }, '*');
  }, []);

  const handleBoundsChange = useCallback((name: string, key: 'min' | 'max', value: number) => {
    setUniformBounds((prev) => {
      const current = prev[name] ?? { min: 0, max: 1 };
      return { ...prev, [name]: { ...current, [key]: value } };
    });
  }, []);

  // Persist geometry, lighting, subdivision, and bg color selections
  useEffect(() => {
    try { localStorage.setItem('fs:previewGeometry', geometry); } catch { /* */ }
  }, [geometry]);
  useEffect(() => {
    try { localStorage.setItem('fs:previewLighting', lighting); } catch { /* */ }
  }, [lighting]);
  useEffect(() => {
    try { localStorage.setItem('fs:previewSubdivision', String(subdivision)); } catch { /* */ }
  }, [subdivision]);
  useEffect(() => {
    try { localStorage.setItem('fs:previewBgColor', bgColor); } catch { /* */ }
  }, [bgColor]);
  useEffect(() => {
    try { localStorage.setItem('fs:previewPlaying', String(playing)); } catch { /* */ }
  }, [playing]);

  // Project-file import (CodeEditor → dispatch `fs:project-imported`):
  // localStorage has already been overwritten with the imported preview prefs
  // by the time this fires, but our useState values were seeded once at mount
  // and would still hold the old ones. Re-read the loaders so the overlay,
  // iframe srcDoc inputs, and uniform sliders pick up the new values without
  // a full page reload.
  useEffect(() => {
    const handler = () => {
      setGeometry(loadGeometry());
      setLighting(loadLighting());
      setSubdivision(loadSubdivision());
      setBgColor(loadBgColor());
      setPlaying(loadPlaying());
      setUniformBounds(loadUniformBounds());
      setUniformValues(loadUniformValues());
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
    return tslToPreviewHTML(previewCode, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewCode, materialSettings, geometryRebuildKey]);

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

  return (
    <div className="shader-preview">
      <div className="shader-preview__controls">
        <button
          className="shader-preview__play-btn"
          onClick={() => setPlaying((p) => !p)}
          title={playing ? 'Pause rotation' : 'Play rotation'}
        >
          {playing ? '\u23F8' : '\u25B6'}
        </button>
        <button
          type="button"
          className="shader-preview__reset-btn"
          onClick={handleReset}
          title="Reset camera, lighting, subdivision, and uniform values to defaults"
        >
          Reset
        </button>
        <input
          type="color"
          className="shader-preview__bg-color"
          value={bgColor}
          onChange={(e) => setBgColor(e.target.value)}
          title="Background color"
        />
        <select
          className="shader-preview__geo-select"
          value={lighting}
          onChange={(e) => setLighting(e.target.value as LightingMode)}
          title="Lighting mode"
        >
          <option value="studio">light: Studio</option>
          <option value="moon">light: Moon</option>
          <option value="laboratory">light: Laboratory</option>
        </select>
        <select
          className="shader-preview__geo-select"
          value={geometry}
          onChange={(e) => setGeometry(e.target.value as GeometryType)}
        >
          <option value="sphere">Sphere</option>
          <option value="cube">Cube</option>
          <option value="plane">Plane</option>
          <option value="teapot">Utah Teapot</option>
          <option value="bunny">Stanford Bunny</option>
        </select>
        {!isObjGeometry(geometry) && (
          <label className="shader-preview__subdivision" title="Mesh subdivision">
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
            title={showUniforms ? 'Hide properties' : 'Show properties'}
          >
            Properties
          </button>
        )}
      </div>
      <div className="shader-preview__body" ref={bodyRef}>
        <iframe
          ref={iframeRef}
          className="shader-preview__iframe"
          srcDoc={containerReady ? previewHtml : undefined}
          title="Shader Preview"
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
          // A-Frame enter-VR button fail silently. fullscreen needs a user
          // gesture to take effect (the button click counts), so granting
          // it doesn't open new attack surface beyond what sandbox already
          // permits. xr-spatial-tracking is the WebXR feature flag; A-Frame
          // probes for it on init regardless of vr-mode-ui state.
          allow="fullscreen; xr-spatial-tracking"
        />
        {uniforms.length > 0 && showUniforms && (
          <div className="shader-preview__uniforms">
            {uniforms.map((u) => {
              const bounds = uniformBounds[u.name] ?? { min: 0, max: 1 };
              const value = uniformValues[u.name] ?? u.defaultValue;
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
                      title="Min"
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
                      title="Max"
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
