import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useAppStore } from '@/store/useAppStore';
import { registerTSLLanguage } from './tslLanguage';
import { tslToAFrame } from '@/engine/tslToAFrame';
import { tslToShaderModule } from '@/engine/tslToShaderModule';
import './CodeEditor.css';

type CodeTab = 'tsl' | 'aframe' | 'module';

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
  const editorRef = useRef<unknown>(null);
  const [activeTab, setActiveTab] = useState<CodeTab>('tsl');

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

  // Only compute export code when that tab is active
  const aframeCode = useMemo(
    () => (activeTab === 'aframe' ? tslToAFrame(code, shaderName) : ''),
    [code, activeTab, shaderName]
  );

  const moduleCode = useMemo(
    () => (activeTab === 'module' ? tslToShaderModule(code) : ''),
    [code, activeTab]
  );

  const isTSL = activeTab === 'tsl';

  const fileBaseName = (shaderName || 'shader')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'shader';

  const handleDownloadHTML = useCallback(() => {
    const blob = new Blob([aframeCode], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileBaseName}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }, [aframeCode, fileBaseName]);

  const handleDownloadModule = useCallback(() => {
    const blob = new Blob([moduleCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileBaseName}.js`;
    a.click();
    URL.revokeObjectURL(url);
  }, [moduleCode, fileBaseName]);

  return (
    <div className="code-editor">
      <div className="code-editor__header">
        <div className="code-editor__tabs">
          <button
            className={`code-editor__tab ${activeTab === 'tsl' ? 'code-editor__tab--active' : ''}`}
            onClick={() => setActiveTab('tsl')}
          >
            TSL
          </button>
          <button
            className={`code-editor__tab ${activeTab === 'aframe' ? 'code-editor__tab--active' : ''}`}
            onClick={() => setActiveTab('aframe')}
          >
            A-Frame
          </button>
          <button
            className={`code-editor__tab ${activeTab === 'module' ? 'code-editor__tab--active' : ''}`}
            onClick={() => setActiveTab('module')}
          >
            Module
          </button>
        </div>
        <div className="code-editor__actions">
          {isTSL && codeErrors.length > 0 && (
            <span className="code-editor__errors">
              {codeErrors.length} error{codeErrors.length > 1 ? 's' : ''}
            </span>
          )}
          {isTSL && (
            <button className="code-editor__save" onClick={requestCodeSync}>
              Save
            </button>
          )}
          {activeTab === 'aframe' && (
            <button className="code-editor__download" onClick={handleDownloadHTML}>
              Download .html
            </button>
          )}
          {activeTab === 'module' && (
            <button className="code-editor__download" onClick={handleDownloadModule}>
              Download .js
            </button>
          )}
        </div>
      </div>
      {isTSL && codeErrors.length > 0 && (
        <div className="code-editor__error-details">
          {codeErrors.map((err, i) => (
            <div key={i} className="code-editor__error-line">
              {err.line ? `Line ${err.line}: ` : ''}{err.message}
            </div>
          ))}
          <div className="code-editor__error-hint">Fix the errors above, then press Save to update the node view.</div>
        </div>
      )}
      <div className="code-editor__body">
        {/* TSL editor — always mounted, hidden when not active */}
        <div className="code-editor__pane" style={{ display: isTSL ? 'block' : 'none' }}>
          <Editor
            height="100%"
            defaultLanguage="javascript"
            value={code}
            onChange={handleChange}
            onMount={handleMount}
            theme="vs"
            options={BASE_EDITOR_OPTIONS}
          />
        </div>
        {/* A-Frame HTML preview (read-only) */}
        {activeTab === 'aframe' && (
          <div className="code-editor__pane">
            <Editor
              height="100%"
              defaultLanguage="html"
              value={aframeCode}
              theme="vs"
              options={READONLY_EDITOR_OPTIONS}
            />
          </div>
        )}
        {/* Shader module preview (read-only) — for a-frame-shaderloader */}
        {activeTab === 'module' && (
          <div className="code-editor__pane">
            <Editor
              height="100%"
              defaultLanguage="javascript"
              value={moduleCode}
              theme="vs"
              options={READONLY_EDITOR_OPTIONS}
            />
          </div>
        )}
      </div>
    </div>
  );
}
