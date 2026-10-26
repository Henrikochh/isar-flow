import { describe, expect, it } from 'vitest';
import { parseWorkflowText } from '@isar-flow/core';
import { buildCanvasModel } from '../../../src/views/workflow/canvas/model';
import { moveTargets } from '../../../src/views/workflow/canvas/moveTargets';
import { reviewWorkflow } from './helpers';

const model = buildCanvasModel(reviewWorkflow());
const summary = (stepId: string, from = model) =>
  moveTargets(from, stepId).map((t) => [t.owner?.id ?? null, t.list.info.slot, t.target.index, t.changes]);

describe('moveTargets', () => {
  it('offers the end of every list in document order', () => {
    expect(summary('tests')).toEqual([
      [null, 'steps', 2, true],
      ['review_loop', 'steps', 3, true],
      ['needs_fix', 'then', 1, true],
      ['needs_fix', 'else', 0, true],
    ]);
  });

  it('never offers a list inside the block, and marks the list it is already last in', () => {
    expect(summary('review_loop')).toEqual([[null, 'steps', 2, false]]);
    expect(summary('needs_fix')).toEqual([
      [null, 'steps', 2, true],
      ['review_loop', 'steps', 3, false],
    ]);
  });

  it('skips lists of containers without an id and knows nothing about unknown blocks', () => {
    const lenient = buildCanvasModel(
      parseWorkflowText(
        'version: 1\nname: W\nsteps:\n  - id: a\n    type: console\n    run: ls\n  - type: loop\n    steps:\n      - id: b\n        type: console\n        run: ls\n',
      ).workflow,
    );
    expect(summary('a', lenient)).toEqual([[null, 'steps', 2, true]]);
    expect(summary('b', lenient)).toEqual([[null, 'steps', 2, true]]);
    expect(moveTargets(lenient, 'missing')).toEqual([]);
  });
});
