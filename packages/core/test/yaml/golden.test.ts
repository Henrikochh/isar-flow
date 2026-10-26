import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyWorkflowOps, parseWorkflowText, type WorkflowOp } from '../../src/yaml';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name), 'utf8');

/** A realistic editing session on the canvas; the result is compared byte for byte. */
const session: WorkflowOp[] = [
  { op: 'updateWorkflow', set: { description: 'Implements a task and reviews it until approved.' } },
  {
    op: 'insertStep',
    target: { parentId: 'review_loop', slot: 'steps', index: 0 },
    step: { id: 'lint', type: 'console', run: 'npm run lint', continueOnError: true },
  },
  {
    op: 'updateStep',
    stepId: 'review',
    set: { prompt: 'Review the changes.\nTests exited with ${{ steps.tests.exitCode }}.\n' },
  },
  { op: 'renameStep', stepId: 'tests', newId: 'unit_tests' },
  {
    op: 'insertStep',
    target: { parentId: 'review_loop', slot: 'steps', index: 99 },
    step: {
      id: 'needs_fix',
      type: 'if',
      condition: { value: '${{ steps.review.json.approved }}', op: 'isFalse' },
      then: [
        {
          id: 'fix',
          type: 'agent',
          agent: 'coder',
          prompt: 'Fix the review findings:\n${{ toJSON(steps.review.json) }}',
        },
      ],
    },
  },
  {
    op: 'updateStep',
    stepId: 'review_loop',
    set: {
      maxIterations: 8,
      until: {
        all: [
          { value: '${{ steps.unit_tests.exitCode }}', op: 'eq', to: 0 },
          { value: '${{ steps.review.json.approved }}', op: 'isTrue' },
        ],
      },
    },
  },
  { op: 'moveStep', stepId: 'lint', target: { parentId: 'review_loop', slot: 'steps', index: 2 } },
  {
    op: 'insertStep',
    target: { parentId: null, slot: 'steps', index: 2 },
    step: { id: 'ship', type: 'approval', message: 'Ship it?' },
  },
];

describe('golden edit session', () => {
  it('produces the expected file, keeping every comment', () => {
    const result = applyWorkflowOps(fixture('commented.workflow.yaml'), session);
    expect(result.error).toBeUndefined();
    expect(result.text).toBe(fixture('commented.after-ops.workflow.yaml'));
    expect(parseWorkflowText(result.text).valid).toBe(true);
  });

  it('round-trips the fixture unchanged when no operation is applied', () => {
    const text = fixture('commented.workflow.yaml');
    expect(applyWorkflowOps(text, [])).toEqual({ text });
  });
});
