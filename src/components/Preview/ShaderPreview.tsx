import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { isObjGeometry, tslToPreviewHTML } from '@/engine/tslToPreviewHTML';
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

function loadUniformBounds(): Record<string, UniformBounds> {
  try {
    const raw = localStorage.getItem('fs:previewUniformBounds');
    if (raw) {
      const parsed = JSON.parse(raw);
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
  const [playing, setPlaying] = useState(false);
  const [lighting, setLighting] = useState<LightingMode>(loadLighting);
  const [subdivision, setSubdivision] = useState<number>(loadSubdivision);
  const [bgColor, setBgColor] = useState(() => {
    try { return localStorage.getItem('fs:previewBgColor') || '#808080'; } catch { return '#808080'; }
  });

  const blobUrlRef = useRef<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Latest camera position reported by the iframe. Stored in a ref (not state)
  // so live position updates from inside the iframe don't retrigger the
  // useMemo that rebuilds the iframe — that would create an infinite loop.
  // The memo reads `current` at rebuild time and embeds it as the restore
  // target for the next iframe instance.
  const cameraPosRef = useRef<CameraPosition | null>(null);
  const rotationRef = useRef<CameraPosition | null>(null);

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
      const data = e.data as { type?: string; x?: number; y?: number; z?: number } | null;
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'fs:preview-ready') {
        const win = iframeRef.current?.contentWindow;
        if (!win) return;
        for (const [name, value] of Object.entries(uniformValuesRef.current)) {
          win.postMessage({ type: 'fs:uniform', name, value }, '*');
        }
      } else if (data.type === 'fs:camera') {
        if (typeof data.x === 'number' && typeof data.y === 'number' && typeof data.z === 'number') {
          cameraPosRef.current = { x: data.x, y: data.y, z: data.z };
        }
      } else if (data.type === 'fs:rotation') {
        if (typeof data.x === 'number' && typeof data.y === 'number' && typeof data.z === 'number') {
          rotationRef.current = { x: data.x, y: data.y, z: data.z };
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
    const win = iframeRef.current?.contentWindow;
    win?.postMessage({ type: 'fs:reset-camera' }, '*');

    // Lighting + subdivision back to defaults. If these are already at the
    // default the setState is a no-op and no iframe rebuild happens — that's
    // fine because we still push uniform values via postMessage below.
    setLighting('studio');
    setSubdivision(SUBDIVISION_DEFAULT);

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

  // OBJ-backed geometries ignore the subdivision slider entirely. Folding the
  // value to a constant in the dep list (instead of the live state) means
  // dragging the slider while a teapot/bunny is selected doesn't rebuild the
  // iframe to produce identical HTML.
  const effectiveSubdivision = isObjGeometry(geometry) ? 0 : subdivision;

  // Generate blob URL for the iframe (more reliable than srcdoc for ES modules + importmaps)
  const blobUrl = useMemo(() => {
    // Revoke previous blob URL
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
    }
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
    const html = tslToPreviewHTML(previewCode, options);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    blobUrlRef.current = url;
    return url;
  }, [previewCode, geometry, playing, materialSettings, bgColor, lighting, effectiveSubdivision]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

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
          src={blobUrl}
          title="Shader Preview"
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
