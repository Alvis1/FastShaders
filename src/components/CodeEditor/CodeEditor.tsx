import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useAppStore } from '@/store/useAppStore';
import { registerTSLLanguage } from './tslLanguage';
import { tslToShaderModule, type PropertyInfo } from '@/engine/tslToShaderModule';
import { scriptToTSL } from '@/engine/scriptToTSL';
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
  const nodes = useAppStore((s) => s.nodes);
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

  const handleDownloadScript = useCallback(() => {
    const blob = new Blob([scriptCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileBaseName}.js`;
    a.click();
    URL.revokeObjectURL(url);
  }, [scriptCode, fileBaseName]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleLoadScript = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const tslCode = scriptToTSL(text);
      setCode(tslCode, 'code');
      setActiveTab('tsl');
      requestCodeSync();
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [setCode, requestCodeSync]);

  return (
    <div className="code-editor">
      <input
        ref={fileInputRef}
        type="file"
        accept=".js"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
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
          {activeTab === 'script' && (
            <button className="code-editor__action-btn" onClick={handleDownloadScript}>
              Download Script
            </button>
          )}
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
