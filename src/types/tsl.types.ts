export interface ParseError {
  message: string;
  line?: number;
  column?: number;
  severity?: 'error' | 'warning';
}

/**
 * One node's piece of the generated module, as a Monaco IRange (1-based
 * lines and columns, `endColumn` exclusive). Bookkeeping beside the text,
 * never part of it (`engine/codeSpans.ts`).
 */
export interface CodeSpan {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  /** own = its body lines, scope Fn copy or sink program (the reveal target);
   *  setup = module scope before `const shader`; use = a Split's read inside
   *  a consumer's own text. */
  kind: 'own' | 'setup' | 'use';
  /** Part of ONE line (a targeted Output's entry, the default's channels
   *  beside `parts`, a Split read) rather than whole lines. */
  inline: boolean;
}

/** A module text and the spans every node emitted in it, held as ONE value so
 *  the two can never describe different texts (the store's `codeNodeSpans`). */
export interface CodeNodeSpans {
  readonly code: string;
  readonly spans: ReadonlyMap<string, readonly CodeSpan[]>;
}

export interface GeneratedCode {
  code: string;
  importStatements: string[];
  /** Map of node ID → generated variable name (e.g. 'color1', 'add2'). */
  varNames: Map<string, string>;
  /** Node ID → its spans in `code`, document order — only nodes that EMITTED
   *  something (an orphaned property, a hidden node, a Split nobody reads
   *  have no entry). */
  nodeSpans: Map<string, CodeSpan[]>;
}
