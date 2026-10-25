import { ExpressionError } from './ast';
import { type ExpressionContext, evaluateExpression } from './evaluate';
import { stringifyValue } from './values';

export interface TemplateMatch {
  /** Expression source between `${{` and `}}`, trimmed. */
  expr: string;
  /** Offset of `$` in the text. */
  start: number;
  /** Offset just after the closing `}}`. */
  end: number;
}

/** Finds `${{ … }}` templates, ignoring `}}` inside quoted string literals. */
export function findTemplateExpressions(text: string): TemplateMatch[] {
  const matches: TemplateMatch[] = [];
  let i = text.indexOf('${{');
  while (i !== -1) {
    const bodyStart = i + 3;
    let j = bodyStart;
    let quote: string | null = null;
    let end = -1;
    while (j < text.length) {
      const c = text[j];
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === '}' && text[j + 1] === '}') {
        end = j;
        break;
      }
      j++;
    }
    if (end === -1) throw new ExpressionError('Unterminated ${{ … }} template', i);
    matches.push({ expr: text.slice(bodyStart, end).trim(), start: i, end: end + 2 });
    i = text.indexOf('${{', end + 2);
  }
  return matches;
}

export function hasTemplate(value: unknown): boolean {
  return typeof value === 'string' && value.includes('${{');
}

/**
 * Renders templates in a string. When the whole string (ignoring surrounding whitespace) is a single
 * template, the raw value is returned so numbers, booleans and objects keep their type.
 */
export function renderTemplate(text: string, ctx: ExpressionContext): unknown {
  if (typeof text !== 'string' || !text.includes('${{')) return text;
  const matches = findTemplateExpressions(text);
  if (matches.length === 0) return text;
  const first = matches[0];
  if (matches.length === 1 && text.slice(0, first.start).trim() === '' && text.slice(first.end).trim() === '') {
    return evaluateExpression(first.expr, ctx);
  }
  let out = '';
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.start) + stringifyValue(evaluateExpression(m.expr, ctx));
    last = m.end;
  }
  return out + text.slice(last);
}

/** Renders a template and always returns text. */
export function renderText(text: string, ctx: ExpressionContext): string {
  return stringifyValue(renderTemplate(text, ctx));
}

/** Renders templates in every string inside a JSON-like value. */
export function renderDeep<T>(value: T, ctx: ExpressionContext): T {
  if (typeof value === 'string') return renderTemplate(value, ctx) as T;
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, ctx)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, ctx)])) as T;
  }
  return value;
}
