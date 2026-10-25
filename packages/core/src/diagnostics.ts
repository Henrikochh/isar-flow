export interface Position {
  /** 0-based line. */
  line: number;
  /** 0-based UTF-16 column. */
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  /** Stable machine-readable code, e.g. 'yaml-syntax', 'unknown-property', 'duplicate-id'. */
  code: string;
  /** Path into the YAML document, e.g. ['steps', 1, 'steps', 0, 'run']. */
  path?: (string | number)[];
  range?: Range;
  /** Id of the innermost block the diagnostic belongs to, used to badge blocks on the canvas. */
  stepId?: string;
}
