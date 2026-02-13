import { useCallback, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useAppStore } from '@/store/useAppStore';
import { registerTSLLanguage } from './tslLanguage';
import './CodeEditor.css';

export function CodeEditor() {
  const code = useAppStore((s) => s.code);
  const codeErrors = useAppStore((s) => s.codeErrors);
  const setCode = useAppStore((s) => s.setCode);
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

  return (
    <div className="code-editor">
      {codeErrors.length > 0 && (
        <div className="code-editor__header">
          <span className="code-editor__errors">
            {codeErrors.length} error{codeErrors.length > 1 ? 's' : ''}
          </span>
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
