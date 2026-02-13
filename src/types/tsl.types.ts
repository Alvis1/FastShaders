export interface ParsedTSLNode {
  variableName: string;
  functionName: string;
  isChainedCall: boolean;
  chainedOn?: string;
  arguments: ParsedTSLArgument[];
  lineNumber: number;
}

export interface ParsedTSLArgument {
  type: 'variable' | 'literal' | 'expression';
  value: string;
  resolvedType?: string;
}

export interface ParseResult {
  success: boolean;
  nodes: ParsedTSLNode[];
  imports: string[];
  outputAssignments: OutputAssignment[];
  errors: ParseError[];
}

export interface OutputAssignment {
  property: string;
  valueExpression: string;
}

export interface ParseError {
  message: string;
  line?: number;
  column?: number;
}

export interface GeneratedCode {
  code: string;
  importStatements: string[];
}
