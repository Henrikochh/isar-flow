import { describe, expect, it } from 'vitest';
import type { ResumeOptions, StepOutput } from '../../src/engine/types';
import type { Step } from '../../src/schema/types';
import { FakeHost } from '../fakes/fakeHost';
import { run, workflow } from '../engine/helpers';

const resume = (stepId: string, outputs: Record<string, StepOutput>): { resume: ResumeOptions } => ({
  resume: { fromRunId: 'run-0', stepId, outputs, loopIterations: {} },
});

const steps: Step[] = [
  { id: 'target', type: 'ask', question: 'Deploy where?', choices: ['dev', 'prod'], default: 'dev' },
  { id: 'build', type: 'console', run: 'npm run build -- ${{ steps.target.answer }}' },
  { id: 'deploy', type: 'console', run: 'deploy ${{ steps.target.answer }}' },
];
const outputs: Record<string, StepOutput> = {
  target: { status: 'success', durationMs: 4000, answer: 'prod', timedOut: false },
  build: { status: 'success', durationMs: 900, exitCode: 0 },
  deploy: { status: 'failure', durationMs: 50, exitCode: 1, error: 'Command exited with code 1' },
};

describe('Run from here with ask blocks', () => {
  it('reuses the stored answer of an ask block before the target without asking again', async () => {
    const host = new FakeHost();
    const r = await run(workflow(steps), { host, ...resume('deploy', outputs) });
    expect(host.askCalls).toEqual([]);
    expect(host.consoleCalls.map((c) => c.command)).toEqual(['deploy prod']);
    expect(r.trace.slice(0, 3)).toEqual(['run-start', 'end:target:success', 'end:build:success']);
    expect(r.output('target')).toEqual(outputs.target);
  });

  it('asks again when the ask block is the target', async () => {
    const host = new FakeHost().ask('target', { answer: 'dev' });
    const r = await run(workflow(steps), { host, ...resume('target', outputs) });
    expect(host.askCalls).toHaveLength(1);
    expect(host.consoleCalls.map((c) => c.command)).toEqual(['npm run build -- dev', 'deploy dev']);
    expect(r.output('target')).toMatchObject({ answer: 'dev', timedOut: false });
  });
});
