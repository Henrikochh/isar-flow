import { describe, expect, it } from 'vitest';
import type { RunEvent, StepOutput, StepStatus, StepType } from '@isar-flow/core';
import { createStyle } from '../src/format';
import { createHumanReporter, useColor } from '../src/output';

const runId = 'r1';
const start = (stepId: string, stepType: StepType, detail?: string, iteration?: number): RunEvent => ({
  type: 'step-start',
  runId,
  stepId,
  stepType,
  at: 0,
  ...(detail !== undefined && { detail }),
  ...(iteration !== undefined && { iteration }),
});
const log = (
  stepId: string,
  text: string,
  stream: 'stdout' | 'info' | 'agent' | 'tool' = 'stdout',
): RunEvent => ({
  type: 'step-log',
  runId,
  stepId,
  stream,
  text,
});
const end = (
  stepId: string,
  status: StepStatus,
  extra: Partial<StepOutput> = {},
  error?: string,
): RunEvent => ({
  type: 'step-end',
  runId,
  stepId,
  status,
  output: { status, ...extra },
  durationMs: 1200,
  at: 0,
  ...(error !== undefined && { error }),
});

function report(events: RunEvent[], color = false): string {
  let text = '';
  const reporter = createHumanReporter((chunk) => (text += chunk), createStyle(color));
  for (const event of events) reporter(event);
  return text;
}

describe('human output', () => {
  it('shows each block with its indented output and how it ended', () => {
    const text = report([
      start('build', 'console', 'npm ci\nnpm test'),
      log('build', 'added 3 packages\npartial'),
      log('build', ' line\n'),
      log('build', 'Retrying soon.\n', 'info'),
      end('build', 'success', { exitCode: 0 }),
      start('fix', 'agent', 'Fix the tests'),
      log('fix', 'Thinking'),
      log('fix', 'readFile src/a.ts\n', 'tool'),
      log('fix', 'Done.', 'agent'),
      end('fix', 'success', { model: 'local/qwen', usage: { inputTokens: 1234, outputTokens: 56 } }),
      start('pick', 'ask', 'Which?'),
      end('pick', 'success', { answer: 'dev', timedOut: true }),
      start('ok', 'approval', 'Go?'),
      end('ok', 'success', { approved: true, comment: 'fine' }),
      end('later', 'skipped'),
    ]);
    expect(text).toBe(
      [
        '▶ build (Console)',
        '    $ npm ci',
        '      npm test',
        '    added 3 packages',
        '    partial line',
        '    Retrying soon.',
        '✓ build succeeded in 1.2 s',
        '▶ fix (Agent)',
        '    Thinking',
        '    readFile src/a.ts',
        '    Done.',
        '✓ fix succeeded in 1.2 s (1,234 in and 56 out tokens, model local/qwen)',
        '▶ pick (Ask)',
        '✓ pick succeeded in 1.2 s (answer: dev, the default after the timeout)',
        '▶ ok (Approval)',
        '✓ ok succeeded in 1.2 s (approved: fine)',
        '- later skipped',
        '',
      ].join('\n'),
    );
  });

  it('indents blocks inside containers and shows loop iterations', () => {
    const text = report([
      start('retry', 'loop'),
      { type: 'loop-iteration', runId, stepId: 'retry', iteration: 2, maxIterations: 3 },
      start('test', 'console', 'npm test', 2),
      log('test', 'boom\n'),
      end('test', 'failure', { exitCode: 1 }, 'Exit code 1'),
      end('retry', 'cancelled'),
    ]);
    expect(text).toBe(
      [
        '▶ retry (Loop)',
        '  ↻ Iteration 2 of 3',
        '  ▶ test (Console, iteration 2)',
        '      $ npm test',
        '      boom',
        '  ✗ test failed in 1.2 s: Exit code 1',
        '■ retry cancelled after 1.2 s',
        '',
      ].join('\n'),
    );
  });

  it('sums up the run', () => {
    const ok = report([
      end('a', 'success'),
      end('b', 'success'),
      end('b', 'success'),
      end('c', 'skipped'),
      {
        type: 'run-end',
        runId,
        status: 'success',
        durationMs: 23_400,
        usage: { inputTokens: 1234, outputTokens: 567 },
      },
    ]);
    expect(ok.split('\n').slice(-3)).toEqual([
      '',
      'Succeeded in 23.4 s: 2 blocks succeeded, 1 skipped. Tokens: 1,234 in, 567 out.',
      '',
    ]);
    const failed = report([
      end('a', 'failure', {}, 'Exit code 2'),
      {
        type: 'run-end',
        runId,
        status: 'failure',
        error: "Block 'a' failed.",
        durationMs: 500,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);
    expect(failed).toContain("\nFailed in 500 ms: Block 'a' failed. 1 block failed.\n");
    const cancelled = report([
      {
        type: 'run-end',
        runId,
        status: 'cancelled',
        durationMs: 2000,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);
    expect(cancelled).toBe('\nCancelled after 2.0 s.\n');
  });

  it('colors status marks and dims notes only with colors on', () => {
    const text = report([start('a', 'console'), log('a', 'note\n', 'info'), end('a', 'success')], true);
    expect(text).toContain('\x1b[32m✓\x1b[0m a succeeded');
    expect(text).toContain('\x1b[2mnote\x1b[0m');
    expect(report([start('a', 'console'), end('a', 'failure', {}, 'x')], true)).toContain('\x1b[31m✗\x1b[0m');
  });

  it('keeps progress output with carriage returns indented', () => {
    const text = report([start('a', 'console'), log('a', '10%\r50%\r100%\n'), end('a', 'success')]);
    expect(text).toContain('    10%\r    50%\r    100%\n');
  });
});

describe('useColor', () => {
  it('colors a terminal unless NO_COLOR is set', () => {
    expect(useColor({ isTTY: true }, {})).toBe(true);
    expect(useColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(useColor({ isTTY: true }, { NO_COLOR: '' })).toBe(true);
    expect(useColor({ isTTY: false }, {})).toBe(false);
    expect(useColor({}, {})).toBe(false);
  });
});
