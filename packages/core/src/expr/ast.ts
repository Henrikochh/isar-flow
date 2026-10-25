export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '<' | '<=' | '>' | '>=' | '==' | '!=';

export type Expr =
  | { kind: 'literal'; value: string | number | boolean | null; start: number }
  | { kind: 'ident'; name: string; start: number }
  | { kind: 'member'; object: Expr; property: Expr; computed: boolean; start: number }
  | { kind: 'call'; callee: string; args: Expr[]; start: number }
  | { kind: 'array'; elements: Expr[]; start: number }
  | { kind: 'unary'; op: '!' | '-'; arg: Expr; start: number }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr; start: number }
  | { kind: 'logical'; op: '&&' | '||'; left: Expr; right: Expr; start: number }
  | { kind: 'conditional'; test: Expr; consequent: Expr; alternate: Expr; start: number };

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly offset?: number,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}
