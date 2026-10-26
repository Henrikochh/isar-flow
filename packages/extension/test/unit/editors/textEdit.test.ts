import { describe, expect, it } from 'vitest';
import { applyWorkflowOps } from '@isar-flow/core';
import { computeReplaceRange, type ReplaceRange } from '../../../src/editors/textEdit';

/** Applies a replacement the way VS Code does, using line/character positions on the old text. */
function apply(oldText: string, edit: ReplaceRange): string {
  const lines = oldText.split(/(?<=\r\n|\n)/);
  const offset = (p: { line: number; character: number }) =>
    lines.slice(0, p.line).reduce((sum, l) => sum + l.length, 0) + p.character;
  return oldText.slice(0, offset(edit.start)) + edit.text + oldText.slice(offset(edit.end));
}

describe('computeReplaceRange', () => {
  it('replaces only the changed span', () => {
    const edit = computeReplaceRange('name: Old\nsteps: []\n', 'name: New\nsteps: []\n');
    expect(edit).toEqual({ start: { line: 0, character: 6 }, end: { line: 0, character: 9 }, text: 'New' });
  });

  it('describes pure insertions as an empty range', () => {
    const edit = computeReplaceRange('a\nc\n', 'a\nb\nc\n');
    expect(edit.start).toEqual(edit.end);
    expect(apply('a\nc\n', edit)).toBe('a\nb\nc\n');
  });

  it('returns an empty edit when nothing changed', () => {
    const edit = computeReplaceRange('same\n', 'same\n');
    expect(edit.text).toBe('');
    expect(edit.start).toEqual(edit.end);
  });

  it('keeps CRLF line breaks intact', () => {
    const oldText = 'version: 1\r\nname: A\r\nsteps: []\r\n';
    const newText = 'version: 1\r\nname: A\r\ndescription: B\r\nsteps: []\r\n';
    const edit = computeReplaceRange(oldText, newText);
    expect(edit.start.line).toBe(2);
    expect(apply(oldText, edit)).toBe(newText);
  });

  it('turns a canvas op into a small edit of a commented file', () => {
    const oldText = [
      '# Review loop',
      'version: 1',
      'name: Review',
      'steps:',
      '  - id: tests # runs the suite',
      '    type: console',
      '    run: npm test',
      '',
    ].join('\n');
    const result = applyWorkflowOps(oldText, [
      { op: 'updateStep', stepId: 'tests', set: { run: 'npm run test:unit' } },
    ]);
    expect(result.error).toBeUndefined();
    const edit = computeReplaceRange(oldText, result.text);
    expect(edit.start.line).toBe(6);
    expect(edit.end.line).toBe(6);
    expect(apply(oldText, edit)).toBe(result.text);
  });
});
