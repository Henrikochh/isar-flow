import { describe, expect, it } from 'vitest';
import { runWorkflow } from '../../src/engine';
import type { EngineHost, RunEvent, RunOptions, RunSummary, StepOutput } from '../../src/engine/types';
import type { AgentDefinition, SimulationFile, Step, Workflow } from '../../src/schema/types';
import { createSimulationHost } from '../../src/simulation';
import { parseWorkflowText, workflowTemplate } from '../../src/yaml';
import { fakeClock, traceOf } from '../engine/helpers';

const agents: Record<string, AgentDefinition> = {
  coder: { name: 'Coder', model: 'litellm/coder' },
  reviewer: { name: 'Reviewer', model: 'litellm/reviewer' },
};

function reviewLoop(): Workflow {
  const { workflow, valid } = parseWorkflowText(workflowTemplate('review-loop', 'Review loop'));
  if (!workflow || !valid) throw new Error('The review-loop template does not parse');
  return workflow;
}

const simple = (steps: Step[]): Workflow => ({ version: 1, name: 'Simple', steps });

interface Simulated {
  events: RunEvent[];
  summary: RunSummary;
  trace: string[];
  output(stepId: string): StepOutput | undefined;
  logs(stepId: string): string[];
}

async function simulate(
  workflow: Workflow,
  host: EngineHost,
  options: Partial<RunOptions> & { onEvent?: (event: RunEvent) => void } = {},
): Promise<Simulated> {
  const { onEvent, ...rest } = options;
  const run = runWorkflow(workflow, {
    runId: 'sim-1',
    inputs: { task: 'Add a login form' },
    agents,
    workspaceRoot: '/ws',
    now: fakeClock(),
    simulated: true,
    ...rest,
    host,
  });
  const events: RunEvent[] = [];
  let next = await run.next();
  while (!next.done) {
    events.push(next.value);
    onEvent?.(next.value);
    next = await run.next();
  }
  const ends = events.filter((e): e is Extract<RunEvent, { type: 'step-end' }> => e.type === 'step-end');
  return {
    events,
    summary: next.value,
    trace: traceOf(events),
    output: (id) => ends.filter((e) => e.stepId === id).at(-1)?.output,
    logs: (id) => events.flatMap((e) => (e.type === 'step-log' && e.stepId === id ? [e.text] : [])),
  };
}

describe('simulated runs through the engine', () => {
  it('runs the review loop from mocks: tests fail once, the reviewer approves in round 2', async () => {
    const file: SimulationFile = {
      blocks: {
        tests: [
          { exitCode: 1, output: '1 failed\n' },
          { exitCode: 0, output: 'all passed\n' },
        ],
        review: [
          { json: { approved: false, issues: ['Add a test'] } },
          { json: { approved: true, issues: [] } },
        ],
      },
    };
    const host = createSimulationHost({ file });
    const r = await simulate(reviewLoop(), host);

    expect(r.trace.filter((t) => !t.startsWith('log:'))).toEqual([
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
    expect(r.summary.status).toBe('success');
    expect(r.summary.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(r.output('review_loop')).toMatchObject({ iterations: 2, exitReason: 'condition' });
    expect(r.output('tests')).toMatchObject({ exitCode: 0, output: 'all passed\n', status: 'success' });
    expect(r.output('review')).toMatchObject({
      json: { approved: true, issues: [] },
      model: 'litellm/reviewer',
      usage: { inputTokens: 0, outputTokens: 0 },
      toolCalls: 0,
    });
    expect(r.output('implement')).toMatchObject({ text: '(simulated answer)', model: 'litellm/coder' });
    expect(r.output('fix')).toMatchObject({ status: 'skipped' });
    expect(host.calls()).toEqual({ implement: 1, tests: 2, review: 2, fix: 1 });

    const firstFix = r.events.find((e) => e.type === 'step-start' && e.stepId === 'fix');
    expect(firstFix).toMatchObject({ detail: expect.stringContaining('"Add a test"') });
    expect(firstFix).toMatchObject({ detail: expect.stringContaining('Test exit code: 1.') });
    expect(r.logs('tests')).toEqual([
      'Simulated: result 1 of 2.\n',
      '1 failed\n',
      'Simulated: result 2 of 2.\n',
      'all passed\n',
    ]);
  });

  it('repeats the last result until the loop gives up', async () => {
    const file: SimulationFile = { blocks: { tests: [{ exitCode: 1, output: 'still failing\n' }] } };
    const host = createSimulationHost({ file });
    const r = await simulate(reviewLoop(), host);
    expect(r.summary.status).toBe('failure');
    expect(r.summary.error).toBe(
      "Loop 'review_loop' reached its limit of 5 iterations without meeting its condition",
    );
    expect(host.calls()).toMatchObject({ tests: 5, review: 5, fix: 5 });
    expect(r.logs('tests').at(-2)).toBe('Simulated: result 1 of 1 (the last result repeats).\n');
    expect(r.output('review')).toMatchObject({ json: { approved: true, issues: [] } });
  });

  it('fails the block with the mocked error', async () => {
    const host = createSimulationHost({
      file: { blocks: { implement: [{ error: 'The model is not reachable.' }] } },
    });
    const r = await simulate(reviewLoop(), host);
    expect(r.summary.status).toBe('failure');
    expect(r.summary.error).toBe("Block 'implement' failed: The model is not reachable.");
    expect(r.output('implement')).toMatchObject({ status: 'failure', error: 'The model is not reachable.' });
    expect(host.calls()).toEqual({ implement: 1 });
  });

  it('lets retries consume the results in order', async () => {
    const workflow = simple([{ id: 'flaky', type: 'console', run: 'npm test', retry: { max: 3 } }]);
    const file: SimulationFile = {
      blocks: { flaky: [{ exitCode: 1 }, { error: 'No shell' }, { exitCode: 0, output: 'ok' }] },
    };
    const host = createSimulationHost({ file });
    const r = await simulate(workflow, host);
    expect(r.summary.status).toBe('success');
    expect(r.output('flaky')).toMatchObject({ exitCode: 0, output: 'ok' });
    expect(host.calls()).toEqual({ flaky: 3 });
    expect(r.logs('flaky').filter((line) => line.startsWith('Simulated'))).toEqual([
      'Simulated: result 1 of 3.\n',
      'Simulated: result 2 of 3.\n',
      'Simulated: result 3 of 3.\n',
    ]);
  });

  it('passes non-JSON mock text of a JSON agent through without json', async () => {
    const workflow = simple([
      {
        id: 'review',
        type: 'agent',
        agent: 'reviewer',
        prompt: 'Review',
        output: { format: 'json', schema: { approved: 'boolean' } },
      },
    ]);
    const host = createSimulationHost({ file: { blocks: { review: [{ text: 'Looks fine to me' }] } } });
    const r = await simulate(workflow, host);
    expect(r.output('review')).toMatchObject({ status: 'success', text: 'Looks fine to me' });
    expect(r.output('review')?.json).toBeUndefined();
  });

  describe('approvals', () => {
    const workflow = (onReject?: 'stop' | 'continue') =>
      simple([
        { id: 'ship', type: 'approval', message: 'Ship ${{ inputs.task }}?', ...(onReject && { onReject }) },
        { id: 'deploy', type: 'console', run: 'deploy' },
      ]);

    it('answers from the mocks', async () => {
      const file: SimulationFile = { blocks: { ship: [{ approved: true, comment: 'Go' }] } };
      const r = await simulate(workflow(), createSimulationHost({ file }));
      expect(r.summary.status).toBe('success');
      expect(r.output('ship')).toMatchObject({ approved: true, comment: 'Go' });
      expect(r.logs('ship')).toEqual(['Simulated: result 1 of 1.\n', 'Answered automatically: approved.\n']);
    });

    it('rejects with approvals: reject and stops the run', async () => {
      const r = await simulate(workflow(), createSimulationHost({ file: { approvals: 'reject' } }));
      expect(r.summary.status).toBe('failure');
      expect(r.summary.error).toBe("Rejected at 'ship'");
      expect(r.output('deploy')).toBeUndefined();
    });

    it('continues after a rejection with onReject: continue', async () => {
      const host = createSimulationHost({ file: { approvals: 'reject' } });
      const r = await simulate(workflow('continue'), host);
      expect(r.summary.status).toBe('success');
      expect(r.output('ship')).toMatchObject({ status: 'success', approved: false, comment: '' });
      expect(host.calls()).toEqual({ ship: 1, deploy: 1 });
    });
  });

  it('cancels during the delay', async () => {
    const controller = new AbortController();
    const host = createSimulationHost({ file: {}, delayMs: 60_000 });
    const started = Date.now();
    const r = await simulate(reviewLoop(), host, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'step-start' && event.stepId === 'implement')
          setTimeout(() => controller.abort(), 5);
      },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.summary.status).toBe('cancelled');
    expect(r.output('implement')).toMatchObject({ status: 'cancelled' });
    expect(host.calls()).toEqual({ implement: 1 });
  });
});
