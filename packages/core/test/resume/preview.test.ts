import { describe, expect, it } from 'vitest';
import type { StepOutput } from '../../src/engine/types';
import { SECRET_MASK } from '../../src/engine';
import { blockHash, createRunView, resumeOptions, resumePreview } from '../../src/run';
import type { RunView, StepRunView } from '../../src/run/types';
import type { Step, Workflow } from '../../src/schema/types';

const setup: Step = { id: 'setup', type: 'console', run: 'setup' };
const added: Step = { id: 'added', type: 'console', run: 'added' };
const plan: Step = { id: 'plan', type: 'agent', model: 'p/m', prompt: 'plan', session: 'continue' };
const review: Step = { id: 'review', type: 'agent', model: 'p/m', prompt: 'review' };
const ship: Step = { id: 'ship', type: 'console', run: 'ship' };
const fix: Step = { id: 'fix', type: 'console', run: 'fix' };
const polish: Step = { id: 'polish', type: 'agent', model: 'p/m', prompt: 'polish', session: 'continue' };
const chat: Step = { id: 'chat', type: 'agent', model: 'p/m', prompt: 'chat', session: 'continue' };
const final: Step = { id: 'final', type: 'agent', model: 'p/m', prompt: 'final', session: 'continue' };
const fresh: Step = { id: 'fresh', type: 'agent', model: 'p/m', prompt: 'fresh', session: 'fresh' };
const gate: Step = { id: 'gate', type: 'if', condition: 'true', then: [ship], else: [fix, polish] };
const work: Step = { id: 'work', type: 'loop', until: 'true', maxIterations: 4, steps: [review, gate, chat] };
const wf: Workflow = { version: 1, name: 'W', steps: [setup, added, plan, work, final, fresh] };

const out = (output: Record<string, unknown> = {}): StepOutput => ({ status: 'success', ...output });
const step = (extra: Partial<StepRunView> = {}): StepRunView => ({
  status: 'success',
  executions: 1,
  logs: [],
  ...extra,
});

function finishedRun(steps: Record<string, StepRunView>, extra: Partial<RunView> = {}): RunView {
  return { ...createRunView('run-0', 'W', 1), status: 'failure', steps, ...extra };
}

const sourceSteps: Record<string, StepRunView> = {
  setup: step({ output: out({ exitCode: 0 }), outputTrimmed: true }),
  plan: step({ output: out({ text: 'plan', json: { notes: [`key ${SECRET_MASK}`] } }) }),
  work: step({ status: 'failure', loop: { iteration: 3, maxIterations: 4 }, output: out({ iterations: 3 }) }),
  review: step({ executions: 3, output: out({ text: 'ok' }) }),
  gate: step({ output: out({ branch: 'then', result: true }) }),
  ship: step({ output: out() }),
  fix: step({ status: 'failure', output: { status: 'failure', exitCode: 1 } }),
  polish: step({ output: out({ text: 'p' }) }),
  chat: step({ status: 'pending', executions: 0 }),
  final: step({ executions: 2, output: out({ text: 'f' }) }),
  fresh: step({ output: out({ text: 'f' }) }),
};
const hashes = { setup: blockHash(setup), plan: 'ffffffffffffff', added: blockHash(added) };

describe('resumePreview', () => {
  it('describes what the run will reuse, force and start fresh', () => {
    const preview = resumePreview(wf, finishedRun(sourceSteps, { blockHashes: hashes }), 'fix');
    expect(preview).toEqual({
      runId: 'run-0',
      stepId: 'fix',
      reused: ['setup', 'plan', 'review'],
      changed: ['plan', 'review'],
      missing: ['added'],
      trimmed: ['setup'],
      masked: ['plan'],
      changesUnknown: false,
      loops: [{ stepId: 'work', iteration: 3, maxIterations: 4 }],
      forcedBranches: [{ stepId: 'gate', branch: 'else' }],
      freshSessions: ['polish', 'final'],
    });
  });

  it("can't tell changes for runs saved without block hashes", () => {
    const preview = resumePreview(wf, finishedRun(sourceSteps), 'fix');
    expect(preview.changesUnknown).toBe(true);
    expect(preview.changed).toEqual([]);
  });

  it('reuses nothing when the target is the first block', () => {
    const preview = resumePreview(wf, finishedRun(sourceSteps, { blockHashes: hashes }), 'setup');
    expect(preview).toMatchObject({ reused: [], missing: [], changed: [], loops: [], forcedBranches: [] });
    expect(preview.freshSessions).toEqual(['plan', 'polish', 'final']);
  });

  it('counts the target itself as a fresh session', () => {
    expect(resumePreview(wf, finishedRun(sourceSteps), 'final').freshSessions).toEqual(['final']);
    expect(resumePreview(wf, finishedRun(sourceSteps), 'final').loops).toEqual([]);
  });

  it('includes the then branch of an if when the target comes after it', () => {
    const preview = resumePreview(wf, finishedRun(sourceSteps), 'final');
    expect(preview.reused).toEqual(['setup', 'plan', 'work', 'review', 'gate', 'ship', 'fix', 'polish']);
    expect(preview.missing).toEqual(['added', 'chat']);
  });

  it('lists nested loops outermost first with their iterations and current limits', () => {
    const inner: Step = { id: 'inner', type: 'loop', maxIterations: '3' as unknown as number, steps: [fix] };
    const outer: Step = { id: 'outer', type: 'loop', maxIterations: 250, steps: [inner] };
    const nested: Workflow = { version: 1, name: 'W', steps: [outer] };
    const runView = finishedRun({ outer: step({ loop: { iteration: 2, maxIterations: 9 } }) });
    expect(resumePreview(nested, runView, 'fix').loops).toEqual([
      { stepId: 'outer', iteration: 2, maxIterations: 100 },
      { stepId: 'inner', iteration: 1, maxIterations: 5 },
    ]);
  });

  it('forces only ifs that took the other branch', () => {
    const preview = (branch: unknown) =>
      resumePreview(wf, finishedRun({ ...sourceSteps, gate: step({ output: out({ branch }) }) }), 'fix');
    expect(preview('else').forcedBranches).toEqual([]);
    expect(preview(undefined).forcedBranches).toEqual([]);
    expect(preview(42).forcedBranches).toEqual([]);
    const thenTarget = resumePreview(
      wf,
      finishedRun({ ...sourceSteps, gate: step({ output: out({ branch: 'else' }) }) }),
      'ship',
    );
    expect(thenTarget.forcedBranches).toEqual([{ stepId: 'gate', branch: 'then' }]);
    expect(thenTarget.reused).toEqual(['setup', 'plan', 'review']);
  });

  it('finds masked secrets anywhere in an output and nothing else', () => {
    const masked = (output: StepOutput) =>
      resumePreview(wf, finishedRun({ ...sourceSteps, setup: step({ output }) }), 'fix').masked;
    expect(masked(out({ list: [[{ deep: `x${SECRET_MASK}y` }]] }))).toEqual(['setup', 'plan']);
    expect(masked(out({ [SECRET_MASK]: 1 }))).toEqual(['setup', 'plan']);
    expect(masked(out({ text: 'plain', n: 3, flag: null }))).toEqual(['plan']);
  });

  it('lists every block once and skips blocks without an id', () => {
    const noId = { type: 'console', run: 'x' } as unknown as Step;
    const twice: Workflow = { version: 1, name: 'W', steps: [setup, noId, setup, fix] };
    const preview = resumePreview(twice, finishedRun(sourceSteps), 'fix');
    expect(preview.reused).toEqual(['setup']);
    expect(preview.missing).toEqual([]);
  });

  it.each([
    ['the block is gone', 'gone', {}, "This block isn't in the workflow anymore."],
    ['the run is still running', 'fix', { status: 'running' }, 'Wait until the run has finished.'],
    [
      'the run was simulated',
      'fix',
      { simulated: true },
      "Simulated runs can't be continued. Run the workflow, then run from a block.",
    ],
  ] as const)('blocks the run when %s', (_label, stepId, extra, blocker) => {
    const preview = resumePreview(wf, finishedRun(sourceSteps, { blockHashes: hashes, ...extra }), stepId);
    expect(preview).toEqual({
      runId: 'run-0',
      stepId,
      blocker,
      reused: [],
      changed: [],
      missing: [],
      trimmed: [],
      masked: [],
      changesUnknown: false,
      loops: [],
      forcedBranches: [],
      freshSessions: [],
    });
  });
});

describe('resumeOptions', () => {
  it('passes every stored output and the loop iterations', () => {
    const options = resumeOptions(wf, finishedRun(sourceSteps), 'fix');
    expect(options).toEqual({
      fromRunId: 'run-0',
      stepId: 'fix',
      outputs: Object.fromEntries(
        Object.entries(sourceSteps).flatMap(([id, s]) => (s.output ? [[id, s.output]] : [])),
      ),
      loopIterations: { work: 3 },
    });
    expect(options.outputs).not.toHaveProperty('chat');
  });

  it('throws the blocker', () => {
    expect(() => resumeOptions(wf, finishedRun(sourceSteps, { status: 'running' }), 'fix')).toThrow(
      'Wait until the run has finished.',
    );
  });
});
