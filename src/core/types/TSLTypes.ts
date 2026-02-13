/**
 * TSL (Three.js Shading Language) Types
 * Defines AST and TSL-related structures
 */

import * as t from '@babel/types';

/**
 * TSL Expression types
 */
export type TSLExpression =
  | 'variable'
  | 'function'
  | 'method'
  | 'constant'
  | 'import';

/**
 * TSL Node (not to be confused with React Flow node)
 */
export interface TSLNode {
  id: string;
  name: string;
  type: TSLExpression;
  functionName?: string;
  methodName?: string;
  arguments?: any[];
  dependencies?: string[];
}

/**
 * Parsed TSL code structure
 */
export interface ParsedTSL {
  imports: string[];
  variables: Map<string, TSLNode>;
  dependencies: Map<string, string[]>;
  exports: string[];
}

/**
 * AST parsing result
 */
export interface ASTParseResult {
  success: boolean;
  ast?: t.File;
  parsed?: ParsedTSL;
  errors?: ParseError[];
}

/**
 * Parse error
 */
export interface ParseError {
  message: string;
  line?: number;
  column?: number;
  code?: string;
}

/**
 * Code generation options
 */
export interface CodeGenerationOptions {
  includeImports?: boolean;
  includeExports?: boolean;
  formatCode?: boolean;
  sortNodes?: boolean;
}

/**
 * Generated code result
 */
export interface GeneratedCode {
  code: string;
  imports: string[];
  exports: string[];
  errors?: string[];
}

/**
 * TSL import mapping
 */
export interface TSLImport {
  module: string;
  imports: string[];
}

/**
 * Common TSL imports
 */
export const TSL_IMPORTS = {
  BASE: 'three/tsl',
  WEBGPU: 'three/webgpu',
  NODES: 'three/nodes'
} as const;

/**
 * TSL function signatures
 */
export interface TSLFunctionSignature {
  name: string;
  parameters: Array<{ name: string; type: string; optional?: boolean }>;
  returnType: string;
  category: string;
}
