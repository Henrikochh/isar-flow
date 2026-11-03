import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/engine/types';
import { blockHashes } from '../../src/run';
import type { Workflow } from '../../src/schema/types';
import { eventsOfType, run, workflow } from '../engine/helpers';

const runStartOf = (events: RunEvent[]) => eventsOfType(events, 'run-start')[0];

describe('run-start context', () => {
  const wf: Workflow = workflow(
    [
      { id: 'build', type: 'console', run: 'echo build' },
      {
        id: 'loop',
        type: 'loop',
        maxIterations: 2,
        steps: [{ id: 'inner', type: 'console', run: 'echo inner' }],
      },
    ],
    { env: { MODE: 'workflow-env-value', SHARED: 'from-workflow' } },
  );

  it('lists env and secret names, the workflow file and the workspace root', async () => {
    const r = await run(wf, {
      env: { PATH_X: 'process-env-value', SHARED: 'process-shared-value' },
      secrets: { TOKEN: 'secret-value-123', API_KEY: 'secret-value-456' },
      workflowFile: '.isarflow/workflows/build.workflow.yaml',
    });
    expect(runStartOf(r.events).context).toEqual({
      env: ['MODE', 'PATH_X', 'SHARED'],
      secrets: ['API_KEY', 'TOKEN'],
      workflow: { name: 'Test workflow', file: '.isarflow/workflows/build.workflow.yaml' },
      workspace: { root: '/ws' },
    });
  });

  it('never puts an env or secret value into an event', async () => {
    const r = await run(wf, {
      env: { PATH_X: 'process-env-value', SHARED: 'process-shared-value' },
      secrets: { TOKEN: 'secret-value-123' },
    });
    const text = JSON.stringify(r.events);
    for (const value of [
      'process-env-value',
      'process-shared-value',
      'workflow-env-value',
      'from-workflow',
      'secret-value-123',
    ]) {
      expect(text).not.toContain(value);
    }
  });

  it('uses empty lists and an empty file without env, secrets or a workflow file', async () => {
    const r = await run(workflow([]));
    expect(runStartOf(r.events).context).toEqual({
      env: [],
      secrets: [],
      workflow: { name: 'Test workflow', file: '' },
      workspace: { root: '/ws' },
    });
  });

  it('carries the hash of every block', async () => {
    const r = await run(wf);
    const start = runStartOf(r.events);
    expect(start.blockHashes).toEqual(blockHashes(wf));
    expect(Object.keys(start.blockHashes ?? {})).toEqual(['build', 'loop', 'inner']);
  });

  it('also carries context and hashes when the inputs are invalid', async () => {
    const r = await run(
      workflow([{ id: 'a', type: 'console', run: 'x' }], {
        inputs: { task: { type: 'string', required: true } },
      }),
    );
    const start = runStartOf(r.events);
    expect(start.context?.workspace.root).toBe('/ws');
    expect(Object.keys(start.blockHashes ?? {})).toEqual(['a']);
    expect(r.summary.status).toBe('failure');
  });
});

describe('run-start marks', () => {
  it('marks simulated runs and leaves normal runs unmarked', async () => {
    const simulated = await run(workflow([]), { simulated: true });
    expect(runStartOf(simulated.events).simulated).toBe(true);
    const normal = await run(workflow([]), { simulated: false });
    expect(runStartOf(normal.events)).not.toHaveProperty('simulated');
    expect(runStartOf(normal.events)).not.toHaveProperty('resumedFrom');
  });

  it('names the run and block a resumed run continues', async () => {
    const r = await run(workflow([{ id: 'a', type: 'console', run: 'x' }]), {
      resume: { fromRunId: 'run-0', stepId: 'a', outputs: {}, loopIterations: {} },
    });
    expect(runStartOf(r.events).resumedFrom).toEqual({ runId: 'run-0', stepId: 'a' });
  });

  it('resumes a simulated run like any other', async () => {
    const r = await run(
      workflow([
        { id: 'a', type: 'console', run: 'x' },
        { id: 'b', type: 'console', run: 'y' },
      ]),
      {
        simulated: true,
        resume: {
          fromRunId: 'run-0',
          stepId: 'b',
          outputs: { a: { status: 'success', exitCode: 0 } },
          loopIterations: {},
        },
      },
    );
    expect(runStartOf(r.events)).toMatchObject({
      simulated: true,
      resumedFrom: { runId: 'run-0', stepId: 'b' },
    });
    expect(r.trace).toEqual(['run-start', 'end:a:success', 'start:b', 'end:b:success', 'run:success']);
  });
});
