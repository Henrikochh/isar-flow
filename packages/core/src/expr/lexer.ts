import { ExpressionError } from './ast';

export type Token =
  | { type: 'number'; value: number; start: number }
  | { type: 'string'; value: string; start: number }
  | { type: 'ident'; value: string; start: number }
  | { type: 'punct'; value: string; start: number }
  | { type: 'eof'; start: number };

// Longest operators first so that '===' wins over '==' and '<=' over '<'.
const OPERATORS = [
  '===',
  '!==',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '?',
  ':',
  '.',
  ',',
  '(',
  ')',
  '[',
  ']',
];

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (isDigit(c)) {
      while (i < src.length && isDigit(src[i])) i++;
      if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
        i++;
        while (i < src.length && isDigit(src[i])) i++;
      }
      tokens.push({ type: 'number', value: Number(src.slice(start, i)), start });
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      let value = '';
      let closed = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\' && i + 1 < src.length) {
          const next = src[i + 1];
          // Unknown escapes keep their backslash so regex patterns like '\d+' work unescaped.
          value += ESCAPES[next] ?? '\\' + next;
          i += 2;
          continue;
        }
        if (ch === c) {
          closed = true;
          i++;
          break;
        }
        value += ch;
        i++;
      }
      if (!closed) throw new ExpressionError('Unterminated string literal', start);
      tokens.push({ type: 'string', value, start });
      continue;
    }
    if (isIdentStart(c)) {
      i++;
      // Dashes are allowed inside identifiers (e.g. steps.my-step.text), like GitHub Actions.
      while (i < src.length && (isIdentPart(src[i]) || (src[i] === '-' && isIdentPart(src[i + 1] ?? ''))))
        i++;
      tokens.push({ type: 'ident', value: src.slice(start, i), start });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      const normalized = op === '===' ? '==' : op === '!==' ? '!=' : op;
      tokens.push({ type: 'punct', value: normalized, start });
      i += op.length;
      continue;
    }
    throw new ExpressionError(`Unexpected character '${c}'`, start);
  }
  tokens.push({ type: 'eof', start: src.length });
  return tokens;
}
