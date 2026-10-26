import { isMap, isScalar, isSeq, type Node, visit, type YAMLMap } from 'yaml';
import { findTemplateExpressions, type TemplateMatch } from '../expr';

/** Identifier as the expression lexer reads it: dashes are allowed between identifier characters. */
const IDENTIFIER = '[A-Za-z_$][A-Za-z0-9_$]*(?:-[A-Za-z0-9_$]+)*';
/** `steps` must not continue another identifier or member chain (`mysteps`, `x.steps`, `a-steps`). */
const NOT_CONTINUATION = '(?<![A-Za-z0-9_$.]|[A-Za-z0-9_$]-)';
/** String literals are matched as a whole so that text inside them is never taken for a reference. */
const STRING_LITERAL = String.raw`'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"`;
const REFERENCE = new RegExp(
  String.raw`${NOT_CONTINUATION}steps(?:\.(${IDENTIFIER})|\[\s*(['"])(.*?)\2\s*\])|${STRING_LITERAL}`,
  'g',
);
const CONDITION_KEYS = ['condition', 'until', 'while'];

/** Rewrites `steps.<old>`, `steps['old']` and `steps["old"]` in expression source, in one pass. */
export function rewriteExpressionReferences(expr: string, renames: ReadonlyMap<string, string>): string {
  if (renames.size === 0 || !expr.includes('steps')) return expr;
  return expr.replace(
    REFERENCE,
    (match: string, dotted: string | undefined, quote: string | undefined, bracketed: string | undefined) => {
      if (dotted !== undefined) {
        const next = renames.get(dotted);
        return next === undefined ? match : `steps.${next}`;
      }
      if (quote === undefined) return match; // a string literal
      const next = renames.get(bracketed ?? '');
      return next === undefined
        ? match
        : match.replace(`${quote}${bracketed}${quote}`, () => `${quote}${next}${quote}`);
    },
  );
}

/** Rewrites step references inside the `${{ … }}` templates of a text; the text around them is left alone. */
export function rewriteStepReferences(text: string, renames: ReadonlyMap<string, string>): string {
  if (renames.size === 0 || !text.includes('${{')) return text;
  let templates: TemplateMatch[];
  try {
    templates = findTemplateExpressions(text);
  } catch {
    return text; // An unterminated template is reported by validation; guessing its end could damage text.
  }
  let out = '';
  let last = 0;
  for (const template of templates) {
    const bodyStart = template.start + 3;
    const bodyEnd = template.end - 2;
    out += text.slice(last, bodyStart) + rewriteExpressionReferences(text.slice(bodyStart, bodyEnd), renames);
    last = bodyEnd;
  }
  return out + text.slice(last);
}

function rewriteScalar(node: unknown, rewrite: (text: string) => string): void {
  if (!isScalar(node) || typeof node.value !== 'string') return;
  const next = rewrite(node.value);
  if (next !== node.value) node.value = next;
}

/** A condition written as plain text (no `${{ }}`) is one expression, so it is rewritten as a whole. */
function rewriteCondition(node: unknown, renames: ReadonlyMap<string, string>): void {
  if (isScalar(node)) {
    if (typeof node.value === 'string' && !node.value.includes('${{')) {
      rewriteScalar(node, (text) => rewriteExpressionReferences(text, renames));
    }
  } else if (isMap(node)) {
    for (const key of ['all', 'any']) {
      const list = node.get(key, true);
      if (isSeq(list)) for (const item of list.items) rewriteCondition(item, renames);
    }
    rewriteCondition(node.get('not', true), renames);
  }
}

/**
 * Rewrites references to renamed blocks in every template below `node` (mapping keys are left alone) and in
 * the plain-expression conditions of `blocks`. Other text, such as shell commands, is never changed.
 */
export function rewriteReferencesIn(
  node: Node,
  blocks: Iterable<YAMLMap>,
  renames: ReadonlyMap<string, string>,
): void {
  if (renames.size === 0) return;
  visit(node, {
    Scalar(key, scalar) {
      if (key !== 'key') rewriteScalar(scalar, (text) => rewriteStepReferences(text, renames));
    },
  });
  for (const block of blocks) {
    for (const key of CONDITION_KEYS) rewriteCondition(block.get(key, true), renames);
  }
}
