import { describe, expect, it } from 'vitest';
import { runWorkflow } from '../../src/engine';
import { lastConditionResult, liveContext, liveValue } from '../../src/live';
import { reduceRunEvent } from '../../src/run';
import type { RunView } from '../../src/run/types';
import { findStep } from '../../src/schema/steps';
import { createSimulationHost } from '../../src/simulation';
import { parseWorkflowText, workflowTemplate } from '../../src/yaml';
import { fakeClock } from '../engine/helpers';

describe('live values of a finished run', () => {
  it('reads values of a simulated review loop', async () => {
    const { workflow } = parseWorkflowText(workflowTemplate('review-loop', 'Review loop'));
    if (!workflow) throw new Error('The review-loop template does not parse');
    const host = createSimulationHost({
      file: {
        blocks: {
          tests: [
            { exitCode: 1, output: `${'x'.repeat(3000)}\n` },
            { exitCode: 0, output: 'PASS\n' },
          ],
          review: [
            { json: { approved: false, issues: ['Add a test'] } },
            { json: { approved: true, issues: [] } },
          ],
        },
      },
    });
    let view: RunView | null = null;
    for await (const event of runWorkflow(workflow, {
      runId: 'sim-1',
      inputs: { task: 'Add a login form' },
      agents: {
        coder: { name: 'Coder', model: 'm/coder' },
        reviewer: { name: 'Reviewer', model: 'm/reviewer' },
      },
      workspaceRoot: '/ws',
      now: fakeClock(),
      host,
    })) {
      view = reduceRunEvent(view, event);
    }
    if (!view) throw new Error('No events');

    const context = liveContext(view);
    const scope = (stepId: string) => ({ workflow, stepId });
    expect(liveValue(context, 'inputs.task')).toMatchObject({ text: 'Add a login form', type: 'text' });
    expect(liveValue(context, 'steps.review.json.approved')).toMatchObject({ text: 'true', type: 'boolean' });
    expect(liveValue(context, 'tail(steps.tests.output, 80)', scope('review'))).toMatchObject({
      text: 'PASS',
      truncated: false,
    });
    expect(liveValue(context, 'loop.iteration', scope('fix'))).toMatchObject({ text: '2', type: 'number' });
    expect(liveValue(context, 'steps.fix.status')).toMatchObject({ text: 'skipped' });
    expect(context.loops).toEqual({ review_loop: { iteration: 2, index: 1 } });

    const step = (id: string) => findStep(workflow.steps, id)?.step;
    expect(lastConditionResult(step('review_loop'), context)).toBe(true);
    expect(lastConditionResult(step('needs_fix'), context)).toBe(false);
  });
});
