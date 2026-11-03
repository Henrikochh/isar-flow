import type { StepOutput } from '../../src/engine/types';
import type { ReviewFile, RunReview } from '../../src/protocol';
import type { RunView, StepRunView } from '../../src/run/types';
import type { Workflow } from '../../src/schema/types';

/** 2026-11-03 14:02 UTC */
export const STARTED = Date.UTC(2026, 10, 3, 14, 2, 0);

export const fixedTime = (epochMs: number) => `T+${Math.round((epochMs - STARTED) / 1000)}s`;

export function step(
  status: StepRunView['status'],
  output: Partial<StepOutput> = {},
  extra: Partial<StepRunView> = {},
): StepRunView {
  return {
    status,
    executions: 1,
    logs: [],
    output: { status, ...output } as StepOutput,
    ...extra,
  };
}

export function metrics(durationMs: number, extra: Partial<NonNullable<StepRunView['metrics']>> = {}) {
  return { metrics: { durationMs, executions: 1, ...extra }, durationMs };
}

/** A review workflow: tests, a loop with two agents, an ask, an approval and a deploy block that did not run. */
export function workflow(): Workflow {
  return {
    version: 1,
    name: 'Review loop',
    steps: [
      { id: 'tests', name: 'Run tests', type: 'console', run: 'npm test' },
      {
        id: 'review-loop',
        type: 'loop',
        maxIterations: 3,
        steps: [
          { id: 'review', type: 'agent', agent: 'reviewer', prompt: 'Review.' },
          { id: 'fix', type: 'agent', agent: 'fixer', prompt: 'Fix.' },
        ],
      },
      { id: 'pick', type: 'ask', question: 'Which environment?', choices: ['dev', 'staging'] },
      { id: 'approve', type: 'approval', message: 'Deploy?' },
      { id: 'deploy', type: 'console', run: 'npm run deploy' },
    ],
  };
}

export function successRun(): RunView {
  return {
    runId: 'run-42',
    workflowName: 'Review loop',
    status: 'success',
    startedAt: STARTED,
    durationMs: 252_000,
    inputs: { branch: 'main', notes: 'a|b\nc' },
    usage: { inputTokens: 12_345, outputTokens: 678 },
    steps: {
      tests: step(
        'success',
        { exitCode: 0, output: 'PASS a.test.ts\nPASS b.test.ts\n' },
        { ...metrics(3200), startedAt: STARTED + 1000 },
      ),
      'review-loop': step(
        'success',
        { iterations: 2, exitReason: 'condition' },
        { ...metrics(200_000, { iterations: 2 }), startedAt: STARTED + 5000 },
      ),
      review: step(
        'success',
        { text: 'Looks good | ship it', model: 'openai/gpt' },
        {
          ...metrics(120_000, {
            executions: 2,
            usage: { inputTokens: 12_000, outputTokens: 600 },
            model: 'openai/gpt',
          }),
          executions: 2,
          startedAt: STARTED + 150_000,
        },
      ),
      fix: step(
        'success',
        { text: 'Fixed `foo`.', model: 'local/llama' },
        {
          ...metrics(60_000, { usage: { inputTokens: 345, outputTokens: 78 }, model: 'local/llama' }),
          startedAt: STARTED + 100_000,
        },
      ),
      pick: step(
        'success',
        { answer: 'staging', timedOut: true },
        { ...metrics(60_000), detail: 'Which environment?', startedAt: STARTED + 200_000 },
      ),
      approve: step(
        'success',
        { approved: true, comment: 'Looks <fine>' },
        { ...metrics(5000), detail: 'Deploy?', startedAt: STARTED + 240_000 },
      ),
    },
  };
}

export function file(path: string, extra: Partial<ReviewFile> = {}): ReviewFile {
  return {
    path,
    status: 'modified',
    additions: 12,
    deletions: 3,
    stepIds: ['fix'],
    decision: 'pending',
    revertible: true,
    ...extra,
  };
}

export function review(files: ReviewFile[], extra: Partial<RunReview> = {}): RunReview {
  return { runId: 'run-42', coverage: 'git', isolation: 'workspace', files, ...extra };
}
