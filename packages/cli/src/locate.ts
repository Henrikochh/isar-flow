import { type Diagnostic, type Range, splitLines } from '@isar-flow/core';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A position for a validation diagnostic, which has a path but no range: the line of the deepest key of its path
 * inside its block (or the whole file), else the block's first line.
 */
export function locateDiagnostic(
  diagnostic: Diagnostic,
  text: string,
  stepRanges: Record<string, Range>,
): Diagnostic {
  if (diagnostic.range) return diagnostic;
  const { stepId } = diagnostic;
  const block = stepId !== undefined && Object.hasOwn(stepRanges, stepId) ? stepRanges[stepId] : undefined;
  const lines = splitLines(text);
  const from = block?.start.line ?? 0;
  const to = block?.end.line ?? lines.length - 1;
  const keys = (diagnostic.path ?? []).filter((part): part is string => typeof part === 'string').reverse();
  for (const key of keys) {
    const pattern = new RegExp(`^(\\s*(?:-\\s+)?)(["']?)${escape(key)}\\2\\s*:`);
    for (let line = from; line <= to && line < lines.length; line++) {
      const match = pattern.exec(lines[line]);
      if (match) {
        const start = { line, character: match[1].length };
        return { ...diagnostic, range: { start, end: start } };
      }
    }
  }
  return block ? { ...diagnostic, range: { start: block.start, end: block.start } } : diagnostic;
}
