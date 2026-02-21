import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { tslToPreviewHTML } from '@/engine/tslToPreviewHTML';
import type { PreviewOptions } from '@/engine/tslToPreviewHTML';
import './ShaderPreview.css';

type GeometryType = 'sphere' | 'cube' | 'torus' | 'plane';

function loadGeometry(): GeometryType {
  try {
    const v = localStorage.getItem('fs:previewGeometry');
    if (v === 'cube' || v === 'torus' || v === 'plane' || v === 'sphere') return v;
  } catch { /* */ }
  return 'cube';
}

export function ShaderPreview() {
  const code = useAppStore((s) => s.code);
  const nodes = useAppStore((s) => s.nodes);

  // Read material settings from the output node
  const outputNode = nodes.find((n) => n.data.registryType === 'output');
  const materialSettings = (outputNode?.data as { materialSettings?: PreviewOptions['materialSettings'] })?.materialSettings;

  const [geometry, setGeometry] = useState<GeometryType>(loadGeometry);
  const [playing, setPlaying] = useState(false);

  // Debounce iframe updates to avoid thrashing on rapid graph changes
  const [debouncedCode, setDebouncedCode] = useState(code);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedCode(code), 500);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [code]);

  // Persist geometry selection
  useEffect(() => {
    try { localStorage.setItem('fs:previewGeometry', geometry); } catch { /* */ }
  }, [geometry]);

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
    };
    const html = tslToPreviewHTML(debouncedCode, options);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    blobUrlRef.current = url;
    return url;
  }, [debouncedCode, geometry, playing, materialSettings]);

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
      <div className="shader-preview__header">
        <span>Preview</span>
        <div className="shader-preview__controls">
          <button
            className="shader-preview__play-btn"
            onClick={() => setPlaying((p) => !p)}
            title={playing ? 'Pause rotation' : 'Play rotation'}
          >
            {playing ? '\u23F8' : '\u25B6'}
          </button>
          <select
            className="shader-preview__geo-select"
            value={geometry}
            onChange={(e) => setGeometry(e.target.value as GeometryType)}
          >
            <option value="sphere">Sphere</option>
            <option value="cube">Cube</option>
            <option value="torus">Torus</option>
            <option value="plane">Plane</option>
          </select>
        </div>
      </div>
      <div className="shader-preview__body">
        <iframe
          className="shader-preview__iframe"
          src={blobUrl}
          title="Shader Preview"
        />
      </div>
    </div>
  );
}
