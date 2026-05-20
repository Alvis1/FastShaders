import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
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
  const [bgColor, setBgColor] = useState(() => {
    try { return localStorage.getItem('fs:previewBgColor') || '#808080'; } catch { return '#808080'; }
  });

  const iframeRef = useRef<HTMLIFrameElement>(null);

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
        const vals = (n.data as { values?: Record<string, unknown> }).values;
        const name = vals?.name as string | undefined;
        if (name) connectedNames.add(name);
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

  // Live slider values — overlay-local; do not write back to the graph (so
  // tweaking a slider doesn't trigger a graph re-sync and tear the iframe down)
  const [uniformValues, setUniformValues] = useState<Record<string, number>>({});
  // When the set of uniform names changes (added/removed/renamed), seed any
  // new entries from their code-side default. Existing entries keep whatever
  // the user has dragged them to.
  const uniformsKey = uniforms.map((u) => `${u.name}=${u.defaultValue}`).join('|');
  useEffect(() => {
    setUniformValues((prev) => {
      const next: Record<string, number> = {};
      let changed = false;
      const currentNames = new Set(uniforms.map((u) => u.name));
      for (const u of uniforms) {
        if (u.name in prev) {
          next[u.name] = prev[u.name];
        } else {
          next[u.name] = u.defaultValue;
          changed = true;
        }
      }
      // Drop stale entries
      for (const k of Object.keys(prev)) {
        if (!currentNames.has(k)) { changed = true; }
      }
      return changed || Object.keys(next).length !== Object.keys(prev).length ? next : prev;
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
        // Re-sync hot-update state after every iframe rebuild — initial
        // postMessages from mount may have been lost if they raced with
        // iframe boot, and after a previewCode/materialSettings change
        // the new iframe document hasn't seen any of our updates yet.
        // The receivers are all idempotent so re-sending current values
        // on top of an already-baked-in initial state is a no-op.
        win.postMessage({ type: 'fs:bg-color', color: bgColorRef.current }, '*');
        win.postMessage(
          { type: 'fs:lighting', lights: LIGHT_PRESETS[lightingRef.current] ?? LIGHT_PRESETS.studio },
          '*',
        );
        win.postMessage(playingPayloadRef.current, '*');
        win.postMessage(geometryPayloadRef.current, '*');
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
  // So only the *structural* props that genuinely require a new shader
  // module (previewCode, materialSettings) drive a rebuild. The closure
  // still captures the current bgColor / lighting / playing / geometry /
  // subdivision so a rebuild driven by previewCode/materialSettings emits
  // HTML with the up-to-date values; the useEffects below push live
  // changes for those props via postMessage without rebuilding.
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
  }, [previewCode, materialSettings]);

  // Hot-update channels: push appearance changes to the running iframe
  // instead of triggering an iframe rebuild. Initial sends on mount may
  // be queued or dropped depending on browser behaviour around postMessage
  // to a still-loading iframe; the re-push on `fs:preview-ready` (in the
  // message handler above) is the safety net that guarantees the iframe
  // converges to the current parent state even if early sends are lost.
  // See BRIDGE_SCRIPT_TEMPLATE in tslToPreviewHTML.ts for the receivers.

  // Build the payload for an `fs:geometry` postMessage. Extracted because
  // the fs:preview-ready handler re-uses it on iframe rebuild to re-sync.
  const buildGeometryPayload = useCallback((): Record<string, unknown> => {
    const isObj = isObjGeometry(geometry);
    const payload: Record<string, unknown> = {
      type: 'fs:geometry',
      isObj,
      rotation: GEOMETRY_ROTATIONS[geometry] ?? '45 45 0',
    };
    if (isObj) {
      payload.objModel = `obj: url(${getModelUrl(geometry as 'teapot' | 'bunny')})`;
      payload.fitBounds = 'size: 1.6';
    } else {
      payload.geometry = buildGeoAttr(
        geometry as 'sphere' | 'cube' | 'plane',
        effectiveSubdivision,
      );
    }
    return payload;
  }, [geometry, effectiveSubdivision]);

  // Build the fs:playing payload. The from/to rotation values are
  // computed in the parent so the iframe doesn't need to know the
  // plane-vs-other axis convention.
  const buildPlayingPayload = useCallback((): Record<string, unknown> => {
    const rawRot = rotationRef.current ?? { x: 0, y: 0, z: 0 };
    const mod360 = (v: number) => ((v % 360) + 360) % 360;
    const r = { x: mod360(rawRot.x), y: mod360(rawRot.y), z: mod360(rawRot.z) };
    const isPlane = geometry === 'plane';
    const from = `${r.x} ${r.y} ${r.z}`;
    const to = isPlane
      ? `${r.x} ${r.y} ${r.z + 360}`
      : `${r.x} ${r.y + 360} ${r.z}`;
    return { type: 'fs:playing', playing, from, to };
  }, [playing, geometry]);

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
    iframeRef.current?.contentWindow?.postMessage(buildPlayingPayload(), '*');
  }, [buildPlayingPayload]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(buildGeometryPayload(), '*');
  }, [buildGeometryPayload]);

  // Keep refs of the latest hot-update payloads so the fs:preview-ready
  // handler can re-sync the iframe after any rebuild without depending on
  // the current closure.
  const bgColorRef = useRef(bgColor);
  const lightingRef = useRef(lighting);
  const playingPayloadRef = useRef(buildPlayingPayload());
  const geometryPayloadRef = useRef(buildGeometryPayload());
  useEffect(() => { bgColorRef.current = bgColor; }, [bgColor]);
  useEffect(() => { lightingRef.current = lighting; }, [lighting]);
  useEffect(() => { playingPayloadRef.current = buildPlayingPayload(); }, [buildPlayingPayload]);
  useEffect(() => { geometryPayloadRef.current = buildGeometryPayload(); }, [buildGeometryPayload]);

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
      <div className="shader-preview__body">
        <iframe
          ref={iframeRef}
          className="shader-preview__iframe"
          srcDoc={previewHtml}
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
