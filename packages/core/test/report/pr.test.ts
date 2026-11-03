import { describe, expect, it } from 'vitest';
import { runReportMarkdown } from '../../src/report';
import type { RunReportInput } from '../../src/report/types';
import type { RunView } from '../../src/run/types';
import { file, metrics, review, STARTED, step, successRun, workflow } from './fixtures';

const pr = (input: RunReportInput, maxChars?: number) =>
  runReportMarkdown(input, { variant: 'pr', ...(maxChars !== undefined && { maxChars }) });

describe('runReportMarkdown: pr', () => {
  it('summarizes a finished run for a pull request', () => {
    const report = pr({
      run: successRun(),
      workflow: workflow(),
      review: review([
        file('src/a.ts', { decision: 'kept' }),
        file('img.png', { binary: true, additions: undefined, deletions: undefined, status: 'added' }),
      ]),
      prices: { 'openai/gpt': { input: 2.5, output: 10 }, 'local/llama': { input: 0, output: 0 } },
    });
    expect(report).toBe(`### Review loop: succeeded in 4m 12s

- Blocks: 6 succeeded, 1 not run
- Tokens: 12,345 in / 678 out
- Cost: 0.04 (estimated)
- Changed files: 2 files (1 kept, 1 pending)
  - \`src/a.ts\` +12 −3
  - \`img.png\` binary

<details><summary>Agent answer</summary>

Looks good | ship it

</details>
`);
  });

  it('names the block and error of a failed run', () => {
    const run: RunView = {
      ...successRun(),
      status: 'failure',
      error: 'Exit code 1.',
      usage: { inputTokens: 0, outputTokens: 0 },
      steps: {
        tests: step(
          'failure',
          { exitCode: 1 },
          { ...metrics(900), error: 'npm test failed:\nexit code 1', startedAt: STARTED },
        ),
      },
    };
    expect(pr({ run, workflow: workflow() }))
      .toBe(`### Review loop: failed at tests: npm test failed: exit code 1

- Blocks: 1 failed, 6 not run
- Changed files: none
`);
  });

  it('prefers the block where the history says the run stopped, and the innermost failed block', () => {
    const run: RunView = {
      ...successRun(),
      status: 'failure',
      steps: {
        'review-loop': step('failure', {}, { ...metrics(900), error: 'Loop failed.', startedAt: STARTED }),
        review: step('failure', {}, { ...metrics(900), error: 'Model unavailable.', startedAt: STARTED + 1 }),
        tests: step(
          'failure',
          { exitCode: 1 },
          { ...metrics(9), error: 'Exit code 1.', startedAt: STARTED + 2 },
        ),
      },
    };
    expect(pr({ run, workflow: workflow() })).toMatch(/^### Review loop: failed at tests: Exit code 1\.\n/);
    const record = {
      runId: 'run-42',
      workflowUri: 'file:///w.yaml',
      workflowName: 'Review loop',
      status: 'failure' as const,
      startedAt: STARTED,
      stoppedAt: 'review',
    };
    expect(pr({ run, workflow: workflow(), record })).toMatch(
      /^### Review loop: failed at review: Model unavailable\.\n/,
    );
    const loopOnly: RunView = { ...run, steps: { 'review-loop': run.steps['review-loop'] } };
    expect(pr({ run: loopOnly, workflow: workflow() })).toMatch(
      /^### Review loop: failed at review-loop: Loop failed\.\n/,
    );
    expect(pr({ run: { ...run, steps: {}, error: 'Budget used up.' } })).toMatch(
      /^### Review loop: failed: Budget used up\.\n/,
    );
    expect(pr({ run: { ...run, steps: {} } })).toMatch(/^### Review loop: failed\n/);
  });

  it('says how a run ended when it was cancelled or is still running', () => {
    const cancelled: RunView = {
      ...successRun(),
      status: 'cancelled',
      steps: { tests: step('cancelled', {}, metrics(100)) },
    };
    expect(pr({ run: cancelled })).toMatch(/^### Review loop: cancelled at tests\n/);
    expect(pr({ run: { ...cancelled, steps: {} } })).toMatch(/^### Review loop: cancelled after 4m 12s\n/);
    const running: RunView = { ...successRun(), status: 'running', durationMs: undefined };
    const report = pr({ run: running });
    expect(report).toMatch(/^### Review loop: running\n/);
    expect(report).toContain('- The run is still running; this report shows what happened so far.');
  });

  it('lists at most 15 files, then how many more', () => {
    const files = Array.from({ length: 20 }, (_, i) => file(`src/f${String(i).padStart(2, '0')}.ts`));
    const report = pr({ run: successRun(), review: review(files) });
    expect(report).toContain('- Changed files: 20 files (20 pending)\n  - `src/f00.ts` +12 −3\n');
    expect(report).toContain('  - `src/f14.ts` +12 −3\n  - and 5 more\n');
    expect(report).not.toContain('f15');
  });

  it('notes simulated, resumed and triggered runs', () => {
    const run: RunView = {
      ...successRun(),
      simulated: true,
      resumedFrom: { runId: 'run-abc', stepId: 'tests' },
      origin: { kind: 'trigger', trigger: 'schedule' },
    };
    const report = pr({ run });
    expect(report).toContain(
      '- Started by its schedule\n' +
        '- Simulated run: nothing was executed; results came from the simulation file.\n' +
        "- Resumed from block `tests` of run run-abc: blocks before it reused that run's results.\n",
    );
    expect(report).not.toContain('Changed files');
  });

  it('shows the answer of the last agent block that ran, cut at 1,500 characters', () => {
    const run = successRun();
    run.steps.fix = step(
      'success',
      { text: 'y'.repeat(3000) },
      { ...metrics(1), startedAt: STARTED + 999_999 },
    );
    const report = pr({ run });
    expect(report).toContain(
      `<details><summary>Agent answer</summary>\n\n${'y'.repeat(1500)}…\n\n(shortened)\n\n</details>\n`,
    );
  });

  it('shows a JSON answer and skips reused answers', () => {
    const run = successRun();
    run.steps.fix = step('success', { json: { ok: true } }, { ...metrics(1), startedAt: STARTED + 999_999 });
    expect(pr({ run })).toContain(
      '<details><summary>Agent answer</summary>\n\n```json\n{\n  "ok": true\n}\n```\n\n</details>',
    );
    run.steps.fix = { ...run.steps.fix, reused: true };
    expect(pr({ run })).toContain('Looks good | ship it');
  });

  it('has no answer section without agent answers', () => {
    const run: RunView = { ...successRun(), steps: { tests: successRun().steps.tests } };
    expect(pr({ run })).not.toContain('<details>');
  });

  it('fits into 4,000 characters by default and into a given maxChars', () => {
    const run = successRun();
    run.steps.review = step(
      'success',
      { text: 'z'.repeat(20_000) },
      { ...metrics(1), startedAt: STARTED + 999_999 },
    );
    const files = Array.from({ length: 400 }, (_, i) => file(`src/a-very-long-folder-name/file-${i}.ts`));
    const input = { run, review: review(files) };
    const report = pr(input);
    expect(report.length).toBeLessThanOrEqual(4000);
    expect(report).toContain('(shortened)');
    expect(report).toContain('</details>');
    for (const max of [3000, 1200, 600, 300, 120, 40, 10, 0]) {
      expect(pr(input, max).length).toBeLessThanOrEqual(max);
    }
  });
});
