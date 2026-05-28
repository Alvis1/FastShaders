import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useAppStore } from '@/store/useAppStore';
import { registerTSLLanguage } from './tslLanguage';
import { tslToShaderModule, type PropertyInfo } from '@/engine/tslToShaderModule';
import { scriptToTSL } from '@/engine/scriptToTSL';
import {
  embedProjectState,
  extractProjectState,
  type FastShadersProject,
} from '@/engine/fastShadersProject';
import { getNodeValues } from '@/types';
import type { MaterialSettings, OutputNodeData } from '@/types';
import { toKebabCase } from '@/utils/nameUtils';
import './CodeEditor.css';

type CodeTab = 'tsl' | 'script';

const BASE_EDITOR_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 14,
  fontFamily: 'var(--font-mono)',
  lineNumbers: 'on' as const,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  tabSize: 2,
  wordWrap: 'on' as const,
  padding: { top: 12 },
  renderLineHighlight: 'gutter' as const,
  overviewRulerBorder: false,
};

const READONLY_EDITOR_OPTIONS = { ...BASE_EDITOR_OPTIONS, readOnly: true };

export function CodeEditor() {
  const code = useAppStore((s) => s.code);
  const codeErrors = useAppStore((s) => s.codeErrors);
  const setCode = useAppStore((s) => s.setCode);
  const requestCodeSync = useAppStore((s) => s.requestCodeSync);
  const shaderName = useAppStore((s) => s.shaderName);
  const setShaderName = useAppStore((s) => s.setShaderName);
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const selectedHeadsetId = useAppStore((s) => s.selectedHeadsetId);
  const setSelectedHeadsetId = useAppStore((s) => s.setSelectedHeadsetId);
  const nodeEditorBgColor = useAppStore((s) => s.nodeEditorBgColor);
  const setNodeEditorBgColor = useAppStore((s) => s.setNodeEditorBgColor);
  const costColorLow = useAppStore((s) => s.costColorLow);
  const setCostColorLow = useAppStore((s) => s.setCostColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const setCostColorHigh = useAppStore((s) => s.setCostColorHigh);
  const codeEditorTheme = useAppStore((s) => s.codeEditorTheme);
  const setCodeEditorTheme = useAppStore((s) => s.setCodeEditorTheme);
  const editorRef = useRef<unknown>(null);
  const isDark = codeEditorTheme === 'vs-dark';

  const outputNode = nodes.find((n) => n.data.registryType === 'output');
  const materialSettings = (outputNode?.data as OutputNodeData | undefined)?.materialSettings;
  const [activeTab, setActiveTab] = useState<CodeTab>('tsl');

  // Extract property definitions from property_float nodes
  const properties: PropertyInfo[] = useMemo(() =>
    nodes
      .filter((n) => n.data.registryType === 'property_float')
      .map((n) => {
        const values = getNodeValues(n);
        return {
          name: String(values.name ?? 'property1'),
          type: 'float' as const,
          defaultValue: Number(values.value ?? 1.0),
        };
      }),
    [nodes]
  );

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    registerTSLLanguage(monaco);
  }, []);

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        setCode(value, 'code');
      }
    },
    [setCode]
  );

  // Ctrl+S / Cmd+S shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        requestCodeSync();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [requestCodeSync]);

  // Only compute export code when that tab is active; catch errors to avoid blank tabs
  const scriptCode = useMemo(() => {
    if (activeTab !== 'script') return '';
    try {
      return tslToShaderModule(code, materialSettings, properties);
    } catch (e) {
      return `// Export error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }, [code, activeTab, materialSettings, properties]);

  const isTSL = activeTab === 'tsl';

  const fileBaseName = toKebabCase(shaderName || 'shader');

  /**
   * Build the FastShaders project snapshot embedded in the downloaded `.js`.
   *
   * Preview-tab settings (geometry, lighting, uniform tunings, camera, …)
   * live in localStorage rather than the zustand store, so we read them
   * directly here — they're treated as user preferences that follow the
   * shader file when re-imported.
   */
  const buildProjectState = useCallback((): FastShadersProject => {
    const ls = (key: string): string | null => {
      try { return localStorage.getItem(key); } catch { return null; }
    };
    const parseJson = <T,>(raw: string | null): T | undefined => {
      if (!raw) return undefined;
      try { return JSON.parse(raw) as T; } catch { return undefined; }
    };

    return {
      version: 1,
      shaderName,
      selectedHeadsetId,
      graph: { nodes, edges },
      preview: {
        geometry: ls('fs:previewGeometry') ?? undefined,
        lighting: ls('fs:previewLighting') ?? undefined,
        subdivision: (() => {
          const v = parseInt(ls('fs:previewSubdivision') ?? '', 10);
          return Number.isNaN(v) ? undefined : v;
        })(),
        bgColor: ls('fs:previewBgColor') ?? undefined,
        playing: ls('fs:previewPlaying') === 'true' ? true : undefined,
        uniformValues: parseJson<Record<string, number>>(ls('fs:previewUniformValues')),
        uniformBounds: parseJson<Record<string, unknown>>(ls('fs:previewUniformBounds')),
        cameraPos: parseJson<{ x: number; y: number; z: number }>(ls('fs:previewCameraPos')),
        rotation: parseJson<{ x: number; y: number; z: number }>(ls('fs:previewRotation')),
      },
      ui: {
        nodeEditorBgColor,
        codeEditorTheme,
        costColorLow,
        costColorHigh,
      },
    };
  }, [
    shaderName,
    selectedHeadsetId,
    nodes,
    edges,
    nodeEditorBgColor,
    codeEditorTheme,
    costColorLow,
    costColorHigh,
  ]);

  const handleDownloadShader = useCallback(() => {
    // `scriptCode` is only memoized when the Script tab is active. From the
    // TSL tab we have to regenerate the module on demand — same call, just
    // not cached.
    const script = activeTab === 'script'
      ? scriptCode
      : (() => {
          try {
            return tslToShaderModule(code, materialSettings, properties);
          } catch (e) {
            return `// Export error: ${e instanceof Error ? e.message : String(e)}`;
          }
        })();

    const embedded = embedProjectState(script, buildProjectState());
    const blob = new Blob([embedded], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileBaseName}.js`;
    a.click();
    URL.revokeObjectURL(url);
  }, [activeTab, scriptCode, code, materialSettings, properties, buildProjectState, fileBaseName]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleLoadScript = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /**
   * Apply a FastShaders project snapshot from an imported `.js`. Graph state
   * is restored via the store (reactively); preview/iframe settings are
   * written to localStorage and a `fs:project-imported` event lets the
   * ShaderPreview re-read its in-memory state from those keys.
   */
  const applyProjectState = useCallback((project: FastShadersProject) => {
    useAppStore.getState().pushHistory();

    if (project.shaderName) setShaderName(project.shaderName);
    if (project.selectedHeadsetId) setSelectedHeadsetId(project.selectedHeadsetId);
    if (project.ui?.nodeEditorBgColor) setNodeEditorBgColor(project.ui.nodeEditorBgColor);
    if (project.ui?.codeEditorTheme === 'vs' || project.ui?.codeEditorTheme === 'vs-dark') {
      setCodeEditorTheme(project.ui.codeEditorTheme);
    }
    if (project.ui?.costColorLow) setCostColorLow(project.ui.costColorLow);
    if (project.ui?.costColorHigh) setCostColorHigh(project.ui.costColorHigh);

    const writeLs = (key: string, value: string | undefined | null) => {
      if (value === undefined || value === null) return;
      try { localStorage.setItem(key, value); } catch { /* quota / private mode */ }
    };
    const p = project.preview ?? {};
    if (p.geometry) writeLs('fs:previewGeometry', p.geometry);
    if (p.lighting) writeLs('fs:previewLighting', p.lighting);
    if (typeof p.subdivision === 'number') writeLs('fs:previewSubdivision', String(p.subdivision));
    if (p.bgColor) writeLs('fs:previewBgColor', p.bgColor);
    if (typeof p.playing === 'boolean') writeLs('fs:previewPlaying', String(p.playing));
    if (p.uniformValues) writeLs('fs:previewUniformValues', JSON.stringify(p.uniformValues));
    if (p.uniformBounds) writeLs('fs:previewUniformBounds', JSON.stringify(p.uniformBounds));
    if (p.cameraPos) writeLs('fs:previewCameraPos', JSON.stringify(p.cameraPos));
    if (p.rotation) writeLs('fs:previewRotation', JSON.stringify(p.rotation));

    // Restore graph last — switching syncSource to 'graph' will trigger
    // graphToCode in useSyncEngine, regenerating the editor code to match.
    useAppStore.setState({
      nodes: project.graph.nodes,
      edges: project.graph.edges,
      syncSource: 'graph',
      isUndoRedo: false,
    });

    // Wake up ShaderPreview so it re-reads localStorage and updates its
    // useState-backed values (geometry/lighting/uniforms/etc.) without a
    // full page reload.
    window.dispatchEvent(new CustomEvent('fs:project-imported'));
  }, [
    setShaderName,
    setSelectedHeadsetId,
    setNodeEditorBgColor,
    setCodeEditorTheme,
    setCostColorLow,
    setCostColorHigh,
  ]);

  const importScriptFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const projectResult = extractProjectState(text);
      if (projectResult) {
        applyProjectState(projectResult.project);
        setActiveTab('tsl');
        return;
      }
      // Plain TSL module — parse back to TSL and re-sync the graph.
      const tslCode = scriptToTSL(text);
      setCode(tslCode, 'code');
      setActiveTab('tsl');
      requestCodeSync();
    };
    reader.readAsText(file);
  }, [setCode, requestCodeSync, applyProjectState]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) importScriptFile(file);
    e.target.value = '';
  }, [importScriptFile]);

  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const dragDepthRef = useRef(0);

  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes('Files');

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFile(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFile(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFile(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!/\.js$/i.test(file.name)) {
      window.alert(`"${file.name}" is not a .js shader script.`);
      return;
    }
    importScriptFile(file);
  }, [importScriptFile]);

  return (
    <div
      className="code-editor"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".js"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      {isDraggingFile && (
        <div className="code-editor__drop-overlay">
          <div className="code-editor__drop-msg">
            <div className="code-editor__drop-title">Drop shader file</div>
            <div className="code-editor__drop-sub">.js — replaces the current shader (graph + preview if embedded)</div>
          </div>
        </div>
      )}
      <div className="code-editor__tabbar">
        <div className="code-editor__tabs">
          <button
            className={`code-editor__tab ${activeTab === 'tsl' ? 'code-editor__tab--active' : ''}`}
            onClick={() => setActiveTab('tsl')}
          >
            TSL
          </button>
          <button
            className={`code-editor__tab ${activeTab === 'script' ? 'code-editor__tab--active' : ''}`}
            onClick={() => setActiveTab('script')}
          >
            Script
          </button>
        </div>
        <div className="code-editor__actions">
          {isTSL && codeErrors.length > 0 && (() => {
            const errorCount = codeErrors.filter(e => e.severity !== 'warning').length;
            const warnCount = codeErrors.filter(e => e.severity === 'warning').length;
            return errorCount > 0 ? (
              <span className="code-editor__errors">
                {errorCount} error{errorCount > 1 ? 's' : ''}
              </span>
            ) : warnCount > 0 ? (
              <span className="code-editor__warnings">
                {warnCount} warning{warnCount > 1 ? 's' : ''}
              </span>
            ) : null;
          })()}
          {isTSL && (
            <button className="code-editor__save" onClick={requestCodeSync}>
              Save
            </button>
          )}
          {isTSL && (
            <button className="code-editor__action-btn" onClick={handleLoadScript} title="Load a shaderloader .js file into the editor">
              Load Script
            </button>
          )}
          <button
            className="code-editor__action-btn"
            onClick={handleDownloadShader}
            title="Download .js shader (with embedded FastShaders project so the file can be dragged back in)"
          >
            Download Shader
          </button>
          <button
            className="code-editor__theme-toggle"
            onClick={() => setCodeEditorTheme(isDark ? 'vs' : 'vs-dark')}
            title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label="Toggle code editor theme"
          >
            {isDark ? '\u263C' : '\u263E'}
          </button>
        </div>
      </div>
      {isTSL && codeErrors.length > 0 && (() => {
        const errors = codeErrors.filter(e => e.severity !== 'warning');
        const warnings = codeErrors.filter(e => e.severity === 'warning');
        return (
          <div className={errors.length > 0 ? 'code-editor__error-details' : 'code-editor__warning-details'}>
            {errors.map((err, i) => (
              <div key={`e${i}`} className="code-editor__error-line">
                {err.line ? `Line ${err.line}: ` : ''}{err.message}
              </div>
            ))}
            {warnings.map((err, i) => (
              <div key={`w${i}`} className="code-editor__warning-line">
                {err.line ? `Line ${err.line}: ` : ''}{err.message}
              </div>
            ))}
            {errors.length > 0 ? (
              <div className="code-editor__error-hint">Fix the errors above, then press Save to update the node view.</div>
            ) : (
              <div className="code-editor__error-hint">Unknown functions are preserved as-is in the graph.</div>
            )}
          </div>
        );
      })()}
      <div className="code-editor__body">
        {/* TSL editor — always mounted, hidden when not active */}
        <div className="code-editor__pane" style={{ display: isTSL ? 'block' : 'none' }}>
          <Editor
            height="100%"
            defaultLanguage="javascript"
            value={code}
            onChange={handleChange}
            onMount={handleMount}
            theme={codeEditorTheme}
            options={BASE_EDITOR_OPTIONS}
          />
          {isTSL && code.trim() === '' && !isDraggingFile && (
            <div className="code-editor__empty-hint">
              {'// Drop a .js shader script here to import, or click Load Script above.'}
            </div>
          )}
        </div>
        {/* Shader script preview (read-only) — for a-frame-shaderloader */}
        {activeTab === 'script' && (
          <div className="code-editor__pane">
            <Editor
              height="100%"
              defaultLanguage="javascript"
              value={scriptCode}
              theme={codeEditorTheme}
              options={READONLY_EDITOR_OPTIONS}
            />
          </div>
        )}
      </div>
    </div>
  );
}
