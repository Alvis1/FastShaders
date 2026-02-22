export interface ParseError {
  message: string;
  line?: number;
  column?: number;
}

export interface GeneratedCode {
  code: string;
  importStatements: string[];
  /** Map of node ID → generated variable name (e.g. 'color1', 'add2'). */
  varNames: Map<string, string>;
}
