import { useCallback, useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useAppStore } from '@/store/useAppStore';
import { registerTSLLanguage } from './tslLanguage';
import './CodeEditor.css';

export function CodeEditor() {
  const code = useAppStore((s) => s.code);
  const codeErrors = useAppStore((s) => s.codeErrors);
  const setCode = useAppStore((s) => s.setCode);
  const requestCodeSync = useAppStore((s) => s.requestCodeSync);
  const editorRef = useRef<unknown>(null);

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

  return (
    <div className="code-editor">
      <div className="code-editor__header">
        {codeErrors.length > 0 && (
          <span className="code-editor__errors">
            {codeErrors.length} error{codeErrors.length > 1 ? 's' : ''}
          </span>
        )}
        <button className="code-editor__save" onClick={requestCodeSync}>
          Save
        </button>
      </div>
      {codeErrors.length > 0 && (
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
        <Editor
          height="100%"
          defaultLanguage="javascript"
          value={code}
          onChange={handleChange}
          onMount={handleMount}
          theme="vs"
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            fontFamily: 'var(--font-mono)',
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: 'on',
            padding: { top: 12 },
            renderLineHighlight: 'gutter',
            overviewRulerBorder: false,
          }}
        />
      </div>
    </div>
  );
}
