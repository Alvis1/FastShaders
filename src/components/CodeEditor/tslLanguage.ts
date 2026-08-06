import type { Monaco } from '@monaco-editor/react';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';

/**
 * Core TSL symbols the registry doesn't enumerate (wrappers, control flow,
 * constructors, geometry attributes). The registry contributes every node's
 * `tslFunction` on top, so a new node type is completable the day it lands.
 */
const CORE_TSL_FUNCTIONS = [
  'Fn', 'If', 'Loop', 'uniform', 'float', 'int',
  'vec2', 'vec3', 'vec4', 'color', 'texture',
] as const;
const CORE_TSL_CONSTANTS = [
  'positionGeometry', 'positionLocal', 'positionWorld', 'normalLocal',
  'tangentLocal', 'cameraPosition', 'time', 'screenUV', 'uv',
] as const;

/** All completable TSL symbols: [name, isFunction]. Built once, lazily. */
let tslSymbols: Array<[string, boolean]> | null = null;
function getTslSymbols(): Array<[string, boolean]> {
  if (tslSymbols) return tslSymbols;
  const seen = new Map<string, boolean>();
  for (const name of CORE_TSL_CONSTANTS) seen.set(name, false);
  for (const name of CORE_TSL_FUNCTIONS) seen.set(name, true);
  for (const def of NODE_REGISTRY.values()) {
    if (def.tslImportModule !== 'three/tsl' || !def.tslFunction) continue;
    if (!seen.has(def.tslFunction)) {
      // `time` (and future uniform-node objects) are values, not callables —
      // a def with no inputs and no defaultValue-emission is accessed bare.
      seen.set(def.tslFunction, def.inputs.length > 0);
    }
  }
  tslSymbols = [...seen.entries()];
  return tslSymbols;
}

/** Guard against double registration if the editor ever remounts. */
let registered = false;

export function registerTSLLanguage(monaco: Monaco) {
  if (registered) return;
  registered = true;

  // Completions: the TSL vocabulary, fed from the node registry. This
  // replaces the retired TypeScript language service (whose 7MB worker
  // type-checked against an all-`any` lib — completions were the only value
  // it delivered). Monaco's word-based suggestions still cover local
  // variables in the buffer.
  type ICompletionModel = Parameters<Parameters<typeof monaco.languages.registerCompletionItemProvider>[1]['provideCompletionItems']>[0];
  type IPosition = Parameters<Parameters<typeof monaco.languages.registerCompletionItemProvider>[1]['provideCompletionItems']>[1];
  monaco.languages.registerCompletionItemProvider('javascript', {
    provideCompletionItems(model: ICompletionModel, position: IPosition) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: getTslSymbols().map(([name, isFn]) => ({
          label: name,
          kind: isFn
            ? monaco.languages.CompletionItemKind.Function
            : monaco.languages.CompletionItemKind.Constant,
          insertText: name,
          detail: "three/tsl",
          range,
        })),
      };
    },
  });

  // Color provider: inline picker for 0xRRGGBB literals
  type ITextModel = Parameters<Parameters<typeof monaco.languages.registerColorProvider>[1]['provideDocumentColors']>[0];
  type IColorInfo = Parameters<Parameters<typeof monaco.languages.registerColorProvider>[1]['provideColorPresentations']>[1];

  monaco.languages.registerColorProvider('javascript', {
    provideDocumentColors(model: ITextModel) {
      const matches: {
        range: InstanceType<typeof monaco.Range>;
        color: { red: number; green: number; blue: number; alpha: number };
      }[] = [];
      const regex = /0x([0-9a-fA-F]{6})\b/g;
      for (let i = 1; i <= model.getLineCount(); i++) {
        const line = model.getLineContent(i);
        let m: RegExpExecArray | null;
        regex.lastIndex = 0;
        while ((m = regex.exec(line)) !== null) {
          const hex = m[1];
          matches.push({
            range: new monaco.Range(i, m.index + 1, i, m.index + 1 + m[0].length),
            color: {
              red: parseInt(hex.slice(0, 2), 16) / 255,
              green: parseInt(hex.slice(2, 4), 16) / 255,
              blue: parseInt(hex.slice(4, 6), 16) / 255,
              alpha: 1,
            },
          });
        }
      }
      return matches;
    },
    provideColorPresentations(_model: ITextModel, colorInfo: IColorInfo) {
      const { red, green, blue } = colorInfo.color;
      const r = Math.round(red * 255).toString(16).padStart(2, '0');
      const g = Math.round(green * 255).toString(16).padStart(2, '0');
      const b = Math.round(blue * 255).toString(16).padStart(2, '0');
      return [{ label: `0x${r}${g}${b}`.toUpperCase() }];
    },
  });
}
