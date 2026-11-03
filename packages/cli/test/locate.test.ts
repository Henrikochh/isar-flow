import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@isar-flow/core';
import { locateDiagnostic } from '../src/locate';

const text = [
  'version: 1',
  'name: Demo',
  'inputs:',
  '  branch: { type: string }',
  'steps:',
  '  - id: build',
  '    type: console',
  '    env:',
  '      "TOKEN": abc',
  '    run: npm test',
  '  - id: ship',
  '    type: console',
  '    run: npm publish',
].join('\n');

const blockRanges = {
  build: { start: { line: 5, character: 4 }, end: { line: 9, character: 17 } },
  ship: { start: { line: 10, character: 4 }, end: { line: 12, character: 20 } },
};

const at = (diagnostic: Partial<Diagnostic>) =>
  locateDiagnostic({ severity: 'warning', code: 'x', message: 'm', ...diagnostic }, text, blockRanges).range
    ?.start;

describe('locateDiagnostic', () => {
  it('keeps a range it already has', () => {
    const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } };
    expect(at({ range })).toEqual(range.start);
  });

  it('finds the deepest key of the path inside the block', () => {
    expect(at({ stepId: 'ship', path: ['steps', 1, 'run'] })).toEqual({ line: 12, character: 4 });
    expect(at({ stepId: 'build', path: ['steps', 0, 'env', 'TOKEN'] })).toEqual({ line: 8, character: 6 });
  });

  it('falls back to the block, then to keys of the whole file', () => {
    expect(at({ stepId: 'ship', path: ['steps', 1, 'agent'] })).toEqual({ line: 10, character: 4 });
    expect(at({ path: ['inputs', 'branch'] })).toEqual({ line: 3, character: 2 });
    expect(at({ path: ['nothing'] })).toBeUndefined();
  });
});
