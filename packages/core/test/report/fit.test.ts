import { describe, expect, it } from 'vitest';
import { fitReport, hardCut } from '../../src/report/fit';
import { runReportMarkdown } from '../../src/report';
import { file, review, step, successRun, workflow, metrics } from './fixtures';

describe('hardCut', () => {
  it('keeps text that fits', () => {
    expect(hardCut('short', 10)).toBe('short');
  });

  it('cuts at a line boundary and says so', () => {
    expect(hardCut('line one\nline two\nline three\n', 25)).toBe('line one\n\n… (shortened)');
  });

  it('closes a code fence and a details element left open', () => {
    const text =
      '<details><summary>Agent answer</summary>\n\n````json\n{\n  "a": 1,\n  "b": 2\n}\n````\n\n</details>\n';
    const result = hardCut(text, 90);
    expect(result).toBe(
      '<details><summary>Agent answer</summary>\n\n````json\n{\n````\n\n</details>\n\n… (shortened)',
    );
    expect(hardCut(text, 70)).toBe('<details><summary>Agent answer</summary>\n\n</details>\n\n… (shortened)');
  });

  it('does not count fences inside other fences or closed details', () => {
    const text = '<details>x</details>\n```\n<details>\n```\nmore text here\nand more\n';
    expect(hardCut(text, 60)).toBe('<details>x</details>\n```\n<details>\n```\n\n… (shortened)');
  });

  it('is only the mark when no line fits, and a plain cut below its length', () => {
    expect(hardCut('x'.repeat(100), 20)).toBe('… (shortened)');
    expect(hardCut('abcdef', 3)).toBe('abc');
    expect(hardCut('a😀b', 2)).toBe('a');
    expect(hardCut('abc', 0)).toBe('');
  });
});

describe('fitReport', () => {
  it('uses the full limits when there is no maxChars or the text fits', () => {
    const limits: number[] = [];
    const render = (l: { answerChars: number }) => {
      limits.push(l.answerChars);
      return 'x'.repeat(l.answerChars);
    };
    expect(fitReport(render, { answerChars: 100, logLines: 10, files: 5 }, undefined)).toHaveLength(100);
    expect(fitReport(render, { answerChars: 100, logLines: 10, files: 5 }, 100)).toHaveLength(100);
    expect(limits).toEqual([100, 100]);
  });

  it('renders with smaller limits until the text fits', () => {
    const seen: { answerChars: number; logLines: number; files: number }[] = [];
    const render = (l: { answerChars: number; logLines: number; files: number }) => {
      seen.push(l);
      return 'x'.repeat(l.answerChars);
    };
    expect(
      fitReport(render, { answerChars: 1000, logLines: 20, files: Number.POSITIVE_INFINITY }, 260),
    ).toHaveLength(250);
    expect(seen).toEqual([
      { answerChars: 1000, logLines: 20, files: Number.POSITIVE_INFINITY },
      { answerChars: 500, logLines: 10, files: 50 },
      { answerChars: 250, logLines: 5, files: 25 },
    ]);
  });

  it('cuts the text when even the smallest limits are too long', () => {
    const result = fitReport(() => 'line\n'.repeat(100), { answerChars: 1, logLines: 1, files: 1 }, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith('… (shortened)')).toBe(true);
    expect(fitReport(() => 'abc', { answerChars: 1, logLines: 1, files: 1 }, Number.NaN)).toBe('abc');
  });
});

describe('runReportMarkdown: maxChars for the full report', () => {
  it('shortens answers, logs and file lists first and never exceeds maxChars', () => {
    const run = successRun();
    run.status = 'failure';
    run.steps.review = step('success', { text: 'answer '.repeat(2000) }, metrics(1));
    run.steps.tests = step(
      'failure',
      { exitCode: 1, output: Array.from({ length: 200 }, (_, i) => `log ${i}`).join('\n') },
      { ...metrics(1), error: 'Exit code 1.' },
    );
    const files = Array.from({ length: 300 }, (_, i) => file(`src/f${i}.ts`));
    const input = { run, workflow: workflow(), review: review(files) };
    const whole = runReportMarkdown(input);
    expect(whole).toContain('| `src/f299.ts` |');

    const fitted = runReportMarkdown(input, { maxChars: 9000 });
    expect(fitted.length).toBeLessThanOrEqual(9000);
    expect(fitted).toContain('(shortened)');
    expect(fitted).toContain('## Errors');
    expect(fitted).toMatch(/And \d+ more files \(shortened\)\./);

    for (const max of [5000, 2000, 700, 100, 13, 0]) {
      expect(runReportMarkdown(input, { maxChars: max }).length).toBeLessThanOrEqual(max);
    }
  });

  it('omits answers and logs entirely at the smallest limits', () => {
    const run = successRun();
    run.status = 'failure';
    run.steps.review = step('success', { text: 'a'.repeat(3000) }, metrics(1));
    run.steps.tests = step(
      'failure',
      { exitCode: 1, output: 'one\ntwo' },
      { ...metrics(1), error: 'Exit code 1.' },
    );
    const input = { run, review: review([file('a.ts')]) };
    const whole = runReportMarkdown(input, { variant: 'full' });
    const small = runReportMarkdown(input, { maxChars: whole.length - 3000 });
    expect(small).toContain('### `review`\n\n(shortened)');
    expect(small).toContain('Output: 2 lines (shortened)');
    expect(small).toContain('And 1 more file (shortened).');
  });
});
