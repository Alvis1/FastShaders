export interface ParseError {
  message: string;
  line?: number;
  column?: number;
}

export interface GeneratedCode {
  code: string;
  importStatements: string[];
}
