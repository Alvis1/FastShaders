/**
 * CodeEditor Component
 * Monaco Editor wrapper for TSL code editing
 */

import { useCallback, useRef } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { useStore } from '../../store';
import styles from './CodeEditor.module.css';

export const CodeEditor: React.FC = () => {
  const { code, setCode } = useStore();
  const editorRef = useRef<any>(null);

  // Handle editor mounting
  const handleEditorDidMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;

    // Configure TypeScript/TSL settings
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });

    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      allowNonTsExtensions: true,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      noEmit: true,
      esModuleInterop: true,
      jsx: monaco.languages.typescript.JsxEmit.React,
      allowJs: true,
      typeRoots: ['node_modules/@types'],
    });

    // Add Three.js TSL types (simplified for now)
    monaco.languages.typescript.typescriptDefaults.addExtraLib(
      `
      declare module 'three/tsl' {
        export function Fn(fn: () => any): any;
        export function noiseNode(): any;
        export function color(hex: number | string): any;
        export function texture(source: any): any;
        export function vec2(x: number, y: number): any;
        export function vec3(x: number, y: number, z: number): any;
        export function vec4(x: number, y: number, z: number, w: number): any;
      }
      `,
      'ts:three-tsl.d.ts'
    );
  }, []);

  // Handle code changes
  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        setCode(value);
      }
    },
    [setCode]
  );

  return (
    <div className={styles.codeEditor}>
      <div className={styles.header}>
        <h3>TSL Code</h3>
        <div className={styles.info}>
          Three.js Shading Language
        </div>
      </div>
      <div className={styles.editorContainer}>
        <Editor
          height="100%"
          defaultLanguage="typescript"
          value={code}
          onChange={handleChange}
          onMount={handleEditorDidMount}
          theme="vs-dark"
          options={{
            minimap: { enabled: true },
            fontSize: 14,
            lineNumbers: 'on',
            roundedSelection: false,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: 'on',
            formatOnPaste: true,
            formatOnType: true,
          }}
        />
      </div>
    </div>
  );
};

export default CodeEditor;
