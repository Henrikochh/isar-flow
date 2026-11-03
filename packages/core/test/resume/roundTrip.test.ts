import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/engine/types';
import { reduceRunEvent, resumeOptions, resumePreview, runRecordSummary } from '../../src/run';
import type { RunView } from '../../src/run/types';
import type { Step, Workflow } from '../../src/schema/types';
import { FakeHost } from '../fakes/fakeHost';
import { eventsOfType, run, workflow } from '../engine/helpers';

const viewOf = (events: RunEvent[]): RunView =>
  events.reduce<RunView | null>((view, event) => reduceRunEvent(view, event), null) as RunView;

const fixLoop: Step = {
  id: 'fixLoop',
  type: 'loop',
  until: '${{ steps.check.exitCode == 0 }}',
  maxIterations: 3,
  steps: [
    { id: 'check', type: 'console', run: 'check', continueOnError: true },
    { id: 'fix', type: 'agent', model: 'p/m', prompt: 'fix ${{ steps.check.output }}' },
  ],
};
const wf: Workflow = workflow([
  { id: 'build', type: 'console', run: 'build' },
  fixLoop,
  { id: 'ship', type: 'console', run: 'ship' },
]);

async function failedSource(): Promise<RunView> {
  const host = new FakeHost()
    .console('build', { output: 'built' })
    .console(
      'check',
      { exitCode: 1, output: 'fail 1' },
      { exitCode: 1, output: 'fail 2' },
      { exitCode: 1, output: 'fail 3' },
    )
    .agent('fix', { usage: { inputTokens: 50, outputTokens: 5 } });
  const source = await run(wf, { host, runId: 'run-0' });
  expect(source.summary.status).toBe('failure');
  return viewOf(source.events);
}

describe('run from here, end to end', () => {
  it('continues a failed loop at its last iteration with the latest outputs', async () => {
    const source = await failedSource();
    expect(runRecordSummary(source, 'u').stoppedAt).toBe('check');
    expect(resumePreview(wf, source, 'check')).toMatchObject({
      reused: ['build'],
      changed: [],
      missing: [],
      changesUnknown: false,
      loops: [{ stepId: 'fixLoop', iteration: 3, maxIterations: 3 }],
    });

    const host = new FakeHost().console('check', { exitCode: 0, output: 'pass' });
    const resumed = await run(wf, { host, resume: resumeOptions(wf, source, 'check') });
    expect(resumed.summary.status).toBe('success');
    expect(host.callOrder).toEqual(['check', 'fix', 'ship']);
    expect(host.agentCalls[0].prompt).toBe('fix pass');
    expect(resumed.output('fixLoop')).toMatchObject({ iterations: 3, exitReason: 'condition' });
    expect(resumed.summary.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

    const view = viewOf(resumed.events);
    expect(view.steps.build).toMatchObject({ reused: true, output: { output: 'built' } });
    const summary = runRecordSummary(view, 'u');
    expect(summary).toMatchObject({ status: 'success', resumedFrom: { runId: 'run-0', stepId: 'check' } });
    expect(summary).not.toHaveProperty('stoppedAt');
  });

  it("seeds the previous iteration's outputs of the whole loop body", async () => {
    const source = await failedSource();
    const host = new FakeHost().console('check', { exitCode: 1, output: 'still failing' });
    const atFix = await run(wf, { host, resume: resumeOptions(wf, source, 'fix') });
    expect(host.agentCalls[0].prompt).toBe('fix fail 3');
    expect(eventsOfType(atFix.events, 'step-end').find((e) => e.stepId === 'check')?.reused).toBe(true);
    expect(atFix.summary.error).toBe(
      "Loop 'fixLoop' reached its limit of 3 iterations without meeting its condition",
    );
  });

  it('warns about blocks that changed since the source run', async () => {
    const source = await failedSource();
    const edited = workflow([{ id: 'build', type: 'console', run: 'build --clean' }, fixLoop]);
    expect(resumePreview(edited, source, 'check').changed).toEqual(['build']);
    const renamed = workflow([{ id: 'build', type: 'console', run: 'build', name: 'Build it' }, fixLoop]);
    expect(resumePreview(renamed, source, 'check').changed).toEqual([]);
  });

  it('keeps flagging a changed block when a resumed run is continued again', async () => {
    const source = await failedSource();
    const edited = workflow([{ id: 'build', type: 'console', run: 'build --clean' }, fixLoop]);
    const host = new FakeHost().console('check', { exitCode: 1, output: 'again' });
    const resumed = await run(edited, {
      host,
      runId: 'run-1',
      resume: resumeOptions(edited, source, 'check'),
    });
    const view = viewOf(resumed.events);
    expect(view.steps.build.reused).toBe(true);

    // build's reused output still comes from the YAML of run-0, not from the edited block.
    expect(resumePreview(edited, view, 'check').changed).toEqual(['build']);
    expect(resumePreview(wf, view, 'check').changed).toEqual([]);
  });

  it('flags every reused block when continuing a run resumed from one saved without hashes', async () => {
    const { blockHashes: _hashes, ...older } = await failedSource();
    const host = new FakeHost().console('check', { exitCode: 1 });
    const resumed = await run(wf, { host, runId: 'run-1', resume: resumeOptions(wf, older, 'check') });
    expect(resumePreview(wf, viewOf(resumed.events), 'check').changed).toEqual(['build']);
  });

  it('gives a run resumed from a resumed run the same earlier iteration outputs', async () => {
    const loop: Workflow = workflow([
      {
        id: 'rounds',
        type: 'loop',
        until: '${{ steps.review.text == "ok" }}',
        maxIterations: 3,
        steps: [
          { id: 'implement', type: 'console', run: 'implement ${{ steps.review.text }}' },
          { id: 'review', type: 'agent', model: 'p/m', prompt: 'review' },
        ],
      },
    ]);
    const first = await run(loop, {
      runId: 'run-0',
      host: new FakeHost()
        .console('implement', { exitCode: 0 }, { exitCode: 1 })
        .agent('review', { text: 'add tests' }),
    });
    expect(first.summary.status).toBe('failure');

    const failAgain = new FakeHost().console('implement', { exitCode: 1 });
    const second = await run(loop, {
      runId: 'run-1',
      host: failAgain,
      resume: resumeOptions(loop, viewOf(first.events), 'implement'),
    });
    expect(failAgain.consoleCalls[0].command).toBe('implement add tests');

    const host = new FakeHost().console('implement', { exitCode: 0 }).agent('review', { text: 'ok' });
    const third = await run(loop, { host, resume: resumeOptions(loop, viewOf(second.events), 'implement') });
    expect(host.consoleCalls[0].command).toBe('implement add tests');
    expect(third.summary.status).toBe('success');
  });

  it('continues cancelled runs', async () => {
    const source: RunView = { ...(await failedSource()), status: 'cancelled' };
    expect(resumePreview(wf, source, 'ship').blocker).toBeUndefined();
    expect(resumeOptions(wf, source, 'ship').loopIterations).toEqual({});
  });
});
