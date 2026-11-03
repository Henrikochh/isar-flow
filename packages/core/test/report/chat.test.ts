import { describe, expect, it } from 'vitest';
import { runReportMarkdown } from '../../src/report';
import type { RunReportInput } from '../../src/report/types';
import type { RunView } from '../../src/run/types';
import { file, metrics, review, step, successRun, workflow } from './fixtures';

const chat = (input: RunReportInput, maxChars?: number) =>
  runReportMarkdown(input, { variant: 'chat', ...(maxChars !== undefined && { maxChars }) });

describe('runReportMarkdown: chat', () => {
  it('gives the outcome and the outputs of the blocks that ran', () => {
    const report = chat({
      run: { ...successRun(), origin: { kind: 'copilot' } },
      workflow: workflow(),
      review: review([file('src/a.ts', { decision: 'kept' }), file('b.ts', { status: 'added' })]),
    });
    expect(report).toBe(`**Review loop** succeeded in 4m 12s.

Tokens: 12,345 in / 678 out.

Started by Copilot.

### Outputs

**Run tests (\`tests\`)** (console): exit code 0

Output:

\`\`\`
PASS a.test.ts
PASS b.test.ts
\`\`\`

**\`review\`** (agent):

Looks good | ship it

**\`fix\`** (agent):

Fixed \`foo\`.

**\`pick\`** (ask): staging (default used)

**\`approve\`** (approval): Approved. Comment: Looks \\<fine>

### Changed files

2 files changed (1 kept, 1 pending).

- \`src/a.ts\` +12 −3, modified, kept
- \`b.ts\` +12 −3, added, pending
`);
  });

  it('shows the last 10 output lines and the errors of a failed run', () => {
    const output = Array.from({ length: 15 }, (_, i) => `out ${i + 1}`).join('\n');
    const run: RunView = {
      ...successRun(),
      status: 'failure',
      error: 'Something else broke.',
      usage: { inputTokens: 0, outputTokens: 0 },
      steps: {
        tests: step('failure', { exitCode: 1, output }, { ...metrics(900), error: 'Exit\ncode 1.' }),
        approve: step('success', { approved: false }, metrics(1)),
        loop: step('success', { iterations: 1 }, metrics(1)),
        silent: step('success', { exitCode: 0 }, metrics(1)),
        nothing: step('success', {}, metrics(1)),
      },
    };
    const tail = Array.from({ length: 10 }, (_, i) => `out ${i + 6}`).join('\n');
    expect(chat({ run })).toBe(`**Review loop** failed at tests: Exit code 1.

### Outputs

**\`tests\`** (console): exit code 1

Last 10 of 15 lines of the output (shortened):

\`\`\`
${tail}
\`\`\`

**\`approve\`** (approval): Rejected

**\`silent\`** (console): exit code 0

### Errors

- Something else broke.
- \`tests\`: Exit code 1.
`);
  });

  it('says when a run is still running or was cancelled', () => {
    const running: RunView = {
      ...successRun(),
      status: 'running',
      steps: {},
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    expect(chat({ run: running })).toBe(
      '**Review loop** is still running.\n\nThe run is still running; this report shows what happened so far.\n',
    );
    const cancelled: RunView = {
      ...running,
      status: 'cancelled',
      steps: { tests: step('cancelled', {}, metrics(5)) },
    };
    expect(chat({ run: cancelled })).toMatch(/^\*\*Review loop\*\* was cancelled at tests\.\n/);
  });

  it('cuts agent answers at 2,000 characters and shows empty or JSON answers', () => {
    const run: RunView = {
      ...successRun(),
      steps: {
        review: step('success', { text: 'q'.repeat(5000) }, metrics(1)),
        fix: step('success', { json: [1, 2] }, metrics(1)),
        pick: step('success', { answer: '' }, metrics(1)),
      },
    };
    const report = chat({ run });
    expect(report).toContain(`**\`review\`** (agent):\n\n${'q'.repeat(2000)}…\n\n(shortened)\n\n`);
    expect(report).toContain('**`fix`** (agent):\n\n```json\n[\n  1,\n  2\n]\n```');
    expect(report).toContain('**`pick`** (ask): (empty)');
  });

  it('fits into 16,000 characters by default and never exceeds maxChars', () => {
    const steps: RunView['steps'] = {};
    for (let i = 0; i < 30; i++)
      steps[`agent${i}`] = step('success', { text: `${i} `.repeat(3000) }, metrics(1));
    const run: RunView = { ...successRun(), steps };
    const report = chat({ run });
    expect(report.length).toBeLessThanOrEqual(16_000);
    expect(report).toContain('(shortened)');
    for (const max of [8000, 2000, 500, 50, 14, 1]) {
      expect(chat({ run }, max).length).toBeLessThanOrEqual(max);
    }
  });
});
