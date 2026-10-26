import { describe, expect, it } from 'vitest';
import type { AgentDefinition, Workflow } from '../../src/schema/types';
import { FakeHost } from '../fakes/fakeHost';
import { run } from './helpers';

const agents: Record<string, AgentDefinition> = {
  coder: {
    name: 'Coder',
    model: 'litellm/coder',
    tools: ['readFile', 'editFile'],
    permissions: { edits: 'auto' },
  },
  reviewer: { name: 'Reviewer', model: 'litellm/reviewer', tools: ['readFile', 'gitDiff'] },
};

const reviewLoop: Workflow = {
  version: 1,
  name: 'Implement & review until approved',
  inputs: { task: { type: 'string', required: true } },
  steps: [
    { id: 'implement', type: 'agent', agent: 'coder', prompt: 'Implement: ${{ inputs.task }}' },
    {
      id: 'review_loop',
      type: 'loop',
      maxIterations: 5,
      until: {
        all: [
          '${{ steps.tests.exitCode == 0 }}',
          { value: '${{ steps.review.json.approved }}', op: 'isTrue' },
        ],
      },
      steps: [
        { id: 'tests', type: 'console', run: 'npm test', continueOnError: true },
        {
          id: 'review',
          type: 'agent',
          agent: 'reviewer',
          prompt:
            'Tests exited with ${{ steps.tests.exitCode }}:\n${{ steps.tests.output }}\nReview the change.',
          output: { format: 'json', schema: { approved: 'boolean', issues: 'string[]' } },
        },
        {
          id: 'needs_fix',
          type: 'if',
          condition: '${{ !steps.review.json.approved }}',
          then: [
            {
              id: 'fix',
              type: 'agent',
              agent: 'coder',
              session: 'continue',
              prompt: 'Fix these issues: ${{ join(steps.review.json.issues, ", ") }}',
            },
          ],
        },
      ],
    },
  ],
};

describe('review loop scenario', () => {
  it('tests fail → reviewer rejects → fixer edits → tests pass → reviewer approves → loop exits on its condition', async () => {
    const host = new FakeHost()
      .agent('implement', { text: 'Implemented', usage: { inputTokens: 100, outputTokens: 50 } })
      .console('tests', { exitCode: 1, stdout: 'FAIL login.test.ts\n' }, { exitCode: 0, stdout: 'PASS\n' })
      .agent(
        'review',
        {
          json: { approved: false, issues: ['missing test', 'naming'] },
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        { json: { approved: true, issues: [] }, usage: { inputTokens: 10, outputTokens: 5 } },
      )
      .agent('fix', { text: 'Fixed', usage: { inputTokens: 20, outputTokens: 10 } });

    const r = await run(reviewLoop, { host, agents, inputs: { task: 'login form' } });

    expect(r.trace).toEqual([
      'run-start',
      'start:implement',
      'end:implement:success',
      'start:review_loop',
      'iter:review_loop:1',
      'start:tests',
      'end:tests:failure',
      'start:review',
      'end:review:success',
      'start:needs_fix',
      'start:fix',
      'end:fix:success',
      'end:needs_fix:success',
      'iter:review_loop:2',
      'start:tests',
      'end:tests:success',
      'start:review',
      'end:review:success',
      'start:needs_fix',
      'end:fix:skipped',
      'end:needs_fix:success',
      'end:review_loop:success',
      'run:success',
    ]);
    expect(r.output('review_loop')).toMatchObject({
      iterations: 2,
      exitReason: 'condition',
      status: 'success',
    });
    expect(r.summary.status).toBe('success');
    expect(r.summary.usage).toEqual({ inputTokens: 140, outputTokens: 70 });

    const [implement, review1, fix, review2] = host.agentCalls;
    expect(implement.prompt).toBe('Implement: login form');
    expect(review1.prompt).toBe('Tests exited with 1:\nFAIL login.test.ts\n\nReview the change.');
    expect(fix.prompt).toBe('Fix these issues: missing test, naming');
    expect(fix.agent).toMatchObject({ name: 'Coder', model: 'litellm/coder' });
    expect(fix.history).toEqual([]);
    expect(review2.prompt).toBe('Tests exited with 0:\nPASS\n\nReview the change.');
    expect(r.summary.steps.fix.status).toBe('skipped');
    expect(r.summary.steps.review.json).toEqual({ approved: true, issues: [] });
  });

  it('fails when the reviewer never approves', async () => {
    const host = new FakeHost()
      .console('tests', { exitCode: 0 })
      .agent('review', { json: { approved: false, issues: ['x'] } });
    const r = await run(reviewLoop, { host, agents, inputs: { task: 't' } });
    expect(r.output('review_loop')).toMatchObject({
      iterations: 5,
      exitReason: 'maxIterations',
      status: 'failure',
    });
    expect(r.summary.error).toBe(
      "Loop 'review_loop' reached its limit of 5 iterations without meeting its condition",
    );
    expect(host.agentCalls.filter((c) => c.stepId === 'fix')).toHaveLength(5);
  });
});
