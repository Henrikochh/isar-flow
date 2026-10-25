import { type BinaryOp, type Expr, ExpressionError } from './ast';
import { type Token, tokenize } from './lexer';

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

/** Parses an expression (without the surrounding `${{ }}`) into an AST. */
export function parseExpression(src: string): Expr {
  if (src.trim() === '') throw new ExpressionError('Empty expression', 0);
  const parser = new Parser(tokenize(src));
  const expr = parser.parseConditional();
  const rest = parser.peek();
  if (rest.type !== 'eof') throw new ExpressionError(`Unexpected ${describe(rest)}`, rest.start);
  return expr;
}

function describe(token: Token): string {
  switch (token.type) {
    case 'eof':
      return 'end of expression';
    case 'string':
      return `string '${token.value}'`;
    default:
      return `'${token.value}'`;
  }
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private isPunct(value: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.value === value;
  }

  private expect(value: string): Token {
    const t = this.next();
    if (t.type !== 'punct' || t.value !== value) {
      throw new ExpressionError(`Expected '${value}' but found ${describe(t)}`, t.start);
    }
    return t;
  }

  parseConditional(): Expr {
    const test = this.parseBinary(1);
    if (!this.isPunct('?')) return test;
    this.next();
    const consequent = this.parseConditional();
    this.expect(':');
    const alternate = this.parseConditional();
    return { kind: 'conditional', test, consequent, alternate, start: test.start };
  }

  private parseBinary(minPrecedence: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const precedence = t.type === 'punct' ? BINARY_PRECEDENCE[t.value] : undefined;
      if (precedence === undefined || precedence < minPrecedence) return left;
      this.next();
      const op = (t as { value: string }).value;
      const right = this.parseBinary(precedence + 1);
      left =
        op === '&&' || op === '||'
          ? { kind: 'logical', op, left, right, start: left.start }
          : { kind: 'binary', op: op as BinaryOp, left, right, start: left.start };
    }
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.type === 'punct' && (t.value === '!' || t.value === '-')) {
      this.next();
      return { kind: 'unary', op: t.value, arg: this.parseUnary(), start: t.start };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(expr: Expr): Expr {
    for (;;) {
      if (this.isPunct('.')) {
        this.next();
        const t = this.next();
        if (t.type !== 'ident' && t.type !== 'number') {
          throw new ExpressionError(`Expected property name but found ${describe(t)}`, t.start);
        }
        expr = {
          kind: 'member',
          object: expr,
          property: { kind: 'literal', value: String(t.value), start: t.start },
          computed: false,
          start: expr.start,
        };
      } else if (this.isPunct('[')) {
        this.next();
        const property = this.parseConditional();
        this.expect(']');
        expr = { kind: 'member', object: expr, property, computed: true, start: expr.start };
      } else {
        return expr;
      }
    }
  }

  private parsePrimary(): Expr {
    const t = this.next();
    switch (t.type) {
      case 'number':
      case 'string':
        return { kind: 'literal', value: t.value, start: t.start };
      case 'ident': {
        if (t.value === 'true' || t.value === 'false') return { kind: 'literal', value: t.value === 'true', start: t.start };
        if (t.value === 'null') return { kind: 'literal', value: null, start: t.start };
        if (this.isPunct('(')) {
          this.next();
          const args: Expr[] = [];
          if (!this.isPunct(')')) {
            do {
              args.push(this.parseConditional());
            } while (this.isPunct(',') && this.next());
          }
          this.expect(')');
          return { kind: 'call', callee: t.value, args, start: t.start };
        }
        return { kind: 'ident', name: t.value, start: t.start };
      }
      case 'punct':
        if (t.value === '(') {
          const inner = this.parseConditional();
          this.expect(')');
          return inner;
        }
        if (t.value === '[') {
          const elements: Expr[] = [];
          if (!this.isPunct(']')) {
            do {
              elements.push(this.parseConditional());
            } while (this.isPunct(',') && this.next());
          }
          this.expect(']');
          return { kind: 'array', elements, start: t.start };
        }
        throw new ExpressionError(`Unexpected ${describe(t)}`, t.start);
      case 'eof':
        throw new ExpressionError('Unexpected end of expression', t.start);
    }
  }
}
