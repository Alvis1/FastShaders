import './monacoSetup';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { registerTSLLanguage } from './tslLanguage';
import { tslToShaderModule, type PropertyInfo } from '@/engine/tslToShaderModule';
import { inlineImageAssetsFromNodes } from '@/engine/imageAssets';
import { importShaderText, importShaderZip, isZipFile } from '@/engine/projectImport';
import { parseCostFile } from '@/utils/costOverride';
import { getNodeValues } from '@/types';
import type { OutputNodeData } from '@/types';
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
  const language = useAppStore((s) => s.language);
  const codeErrors = useAppStore((s) => s.codeErrors);
  const setCode = useAppStore((s) => s.setCode);
  const requestCodeSync = useAppStore((s) => s.requestCodeSync);
  const nodes = useAppStore((s) => s.nodes);
  const codeEditorTheme = useAppStore((s) => s.codeEditorTheme);
  const editorRef = useRef<unknown>(null);

  const outputNode = nodes.find((n) => n.data.registryType === 'output');
  const materialSettings = (outputNode?.data as OutputNodeData | undefined)?.materialSettings;
  const [activeTab, setActiveTab] = useState<CodeTab>('tsl');

  // Extract property definitions from property_float / property_color nodes
  const properties: PropertyInfo[] = useMemo(() =>
    nodes
      .filter((n) => n.data.registryType === 'property_float' || n.data.registryType === 'property_color')
      .map((n) => {
        const values = getNodeValues(n);
        if (n.data.registryType === 'property_color') {
          return {
            name: String(values.name ?? 'color1'),
            type: 'color' as const,
            defaultValue: String(values.hex ?? '#ff0000'),
          };
        }
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

  // Only compute export code when that tab is active; catch errors to avoid blank tabs.
  // The Output tab shows the REAL module, so image placeholders are expanded back
  // to their `data:` payloads here — the TSL tab above keeps the short references.
  const scriptCode = useMemo(() => {
    if (activeTab !== 'script') return '';
    try {
      return tslToShaderModule(inlineImageAssetsFromNodes(code, nodes), materialSettings, properties);
    } catch (e) {
      return `// Export error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }, [code, nodes, activeTab, materialSettings, properties]);

  const isTSL = activeTab === 'tsl';

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleLoadScript = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Project/script import logic is shared with the canvas drop —
  // see src/engine/projectImport.ts. This wrapper only adds the tab switch.
  const importScriptFile = useCallback((file: File) => {
    // A benchmark complexity patch / suggestion .json reprices node costs (adds
    // a measured device profile) — it is NOT a shader script, so handle it
    // before the script/zip import path. Adversarial: parseCostFile validates.
    if (/\.json$/i.test(file.name)) {
      file.text()
        .then((text) => {
          const parsed = parseCostFile(text, file.name);
          if (!parsed) {
            window.alert(t('That JSON is not a recognizable complexity patch or bench suggestion.', language));
            return;
          }
          if (
            parsed.meta.valid === false &&
            !window.confirm(
              `${t('This benchmark run was flagged invalid:', language)}\n\n` +
              `${parsed.meta.reasons.join('\n')}\n\n` +
              t('Add it as a device profile anyway?', language),
            )
          ) return;
          useAppStore.getState().importCostProfile(parsed);
        })
        .catch(() => window.alert(t('Could not read that file.', language)));
      return;
    }
    if (isZipFile(file)) {
      importShaderZip(file)
        .then((result) => {
          if (result === null) {
            window.alert(`"${file.name}" doesn't contain a shader script (.js / .mjs / .tsl).`);
            return;
          }
          setActiveTab('tsl');
        })
        .catch(() => {
          // Imported files are adversarial input — a crash inside the import
          // must surface, not silently no-op the Load.
          window.alert(`Could not import "${file.name}" — the file appears corrupted.`);
        });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        importShaderText(String(reader.result ?? ''));
        setActiveTab('tsl');
      } catch {
        window.alert(`Could not import "${file.name}" — the file appears corrupted.`);
      }
    };
    reader.readAsText(file);
  }, [language]);

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
    if (!/\.(js|mjs|tsl|zip|json)$/i.test(file.name)) {
      window.alert(`"${file.name}" is not a shader script (.js / .mjs / .tsl), a FastShaders .zip, or a benchmark complexity .json.`);
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
        accept=".js,.mjs,.tsl,.zip,.json"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      {isDraggingFile && (
        <div className="code-editor__drop-overlay">
          <div className="code-editor__drop-msg">
            <div className="code-editor__drop-title">{t('Drop shader file', language)}</div>
            <div className="code-editor__drop-sub">{t('.js / .mjs / .tsl or FastShaders .zip replaces the shader — or drop a benchmark complexity.json to reprice nodes', language)}</div>
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
            {t('Output', language)}
          </button>
        </div>
        <div className="code-editor__actions">
          {isTSL && codeErrors.length > 0 && (() => {
            const errorCount = codeErrors.filter(e => e.severity !== 'warning').length;
            const warnCount = codeErrors.filter(e => e.severity === 'warning').length;
            return errorCount > 0 ? (
              <span className="code-editor__errors">
                {errorCount} {t(errorCount > 1 ? 'errors' : 'error', language)}
              </span>
            ) : warnCount > 0 ? (
              <span className="code-editor__warnings">
                {warnCount} {t(warnCount > 1 ? 'warnings' : 'warning', language)}
              </span>
            ) : null;
          })()}
          {isTSL && (
            <button
              className="code-editor__save"
              onClick={requestCodeSync}
              title={t('Compile this TSL into the node graph — your work is auto-saved separately', language)}
            >
              {t('Apply', language)}
            </button>
          )}
          {isTSL && (
            <button className="code-editor__action-btn" onClick={handleLoadScript} title={t('Import a shaderloader .js file into the editor', language)}>
              {t('Import', language)}
            </button>
          )}
        </div>
      </div>
      {isTSL && codeErrors.length > 0 && (() => {
        const errors = codeErrors.filter(e => e.severity !== 'warning');
        const warnings = codeErrors.filter(e => e.severity === 'warning');
        return (
          <div className={errors.length > 0 ? 'code-editor__error-details' : 'code-editor__warning-details'}>
            {errors.map((err, i) => (
              <div key={`e${i}`} className="code-editor__error-line">
                {err.line ? t('Line {n}: ', language).replace('{n}', String(err.line)) : ''}{err.message}
              </div>
            ))}
            {warnings.map((err, i) => (
              <div key={`w${i}`} className="code-editor__warning-line">
                {err.line ? t('Line {n}: ', language).replace('{n}', String(err.line)) : ''}{err.message}
              </div>
            ))}
            {errors.length > 0 ? (
              <div className="code-editor__error-hint">{t('Fix the errors above, then press Apply to update the node view.', language)}</div>
            ) : (
              <div className="code-editor__error-hint">{t('Unknown functions are preserved as-is in the graph.', language)}</div>
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
              {t('// Drop a .js / .zip shader or a benchmark complexity.json here, or click Import above.', language)}
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
