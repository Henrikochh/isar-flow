import { describe, expect, it } from 'vitest';
import type { LiveContext } from '@isar-flow/core';
import { liveValueHover } from '../../../src/liveValues/hover';

const NOW = Date.UTC(2026, 10, 3, 12, 0);
const MINUTE = 60_000;

const CONTEXT: LiveContext = {
  runId: 'r1',
  startedAt: NOW - 4 * MINUTE,
  status: 'failure',
  inputs: { task: 'login' },
  steps: {
    tests: { status: 'failure', exitCode: 1, output: '1 failed', stderr: '' },
    review: { status: 'success', text: 'Two issues', json: { approved: false, issues: ['x'] } },
    check: { status: 'success', exitCode: 0 },
    fix_loop: { status: 'success', iterations: 2 },
  },
  loops: { fix_loop: { iteration: 2, index: 1 } },
  env: ['HOME'],
  secrets: ['token'],
  workflow: { name: 'Review', file: '.isarflow/workflows/review.workflow.yaml' },
  workspace: { root: '/w' },
};

const HEADER = '**Value in the last run** (failed, 4 min ago)';

/** A workflow whose block `notes` runs `echo <template>`; `check` sits in the loop `fix_loop`. */
const workflowText = (template: string) =>
  [
    'version: 1',
    'name: Review',
    'steps:',
    '  - id: tests',
    '    type: console',
    '    run: npm test',
    '  - id: fix_loop',
    '    type: loop',
    "    until: { value: '${{ loop.iteration }}', op: eq, to: 2 }",
    '    maxIterations: 3',
    '    steps:',
    '      - id: check',
    '        type: console',
    '        run: echo ${{ loop.iteration }}',
    '  - id: notes',
    '    type: console',
    `    run: echo ${template}`,
    '',
  ].join('\n');

/** Hovers inside the last occurrence of `template` (the one in `notes` unless `index` says otherwise). */
function hover(template: string, context: LiveContext = CONTEXT, text = workflowText(template)) {
  const start = text.lastIndexOf(template);
  return liveValueHover(text, start + 4, context, NOW);
}

describe('liveValueHover', () => {
  it.each([
    ['text', '${{ steps.tests.output }}', '```text\n1 failed\n```'],
    ['a number', '${{ steps.tests.exitCode }}', '```text\n1\n```'],
    ['a boolean', '${{ steps.tests.exitCode == 1 }}', '```text\ntrue\n```'],
    ['an input', '${{ inputs.task }}', '```text\nlogin\n```'],
    ['a list', '${{ steps.review.json.issues }}', '```json\n[\n  "x"\n]\n```'],
    [
      'an object',
      '${{ steps.review.json }}',
      '```json\n{\n  "approved": false,\n  "issues": [\n    "x"\n  ]\n}\n```',
    ],
    ['an empty value', '${{ steps.tests.stderr }}', '_Empty_'],
    ['a missing value', '${{ steps.check.nothing }}', '_Empty_'],
  ])('shows %s in a fenced block', (_name, template, body) => {
    expect(hover(template)?.markdown).toBe(`${HEADER}\n\n${body}`);
  });

  it.each([
    ['environment values', '${{ env.HOME }}', "_Environment values aren't saved with runs._"],
    [
      'blocks without a result',
      '${{ steps.missing_block.output }}',
      '_missing\\_block has no result in this run._',
    ],
    ['loop outside a loop', '${{ loop.iteration }}', '_loop is only set inside a loop._'],
  ])('says why %s are not available, in italics', (_name, template, body) => {
    expect(hover(template)?.markdown).toBe(`${HEADER}\n\n${body}`);
  });

  it('shows evaluation errors in italics', () => {
    const markdown = hover('${{ steps.tests.output == }}')?.markdown ?? '';
    expect(markdown.startsWith(`${HEADER}\n\n_`)).toBe(true);
    expect(markdown.endsWith('_')).toBe(true);
    expect(markdown).not.toContain('```');
  });

  it('notes cut values and masked secrets', () => {
    const long = {
      ...CONTEXT,
      steps: { ...CONTEXT.steps, tests: { status: 'success' as const, output: 'x'.repeat(3000) } },
    };
    expect(hover('${{ steps.tests.output }}', long)?.markdown).toBe(
      `${HEADER}\n\n\`\`\`text\n${'x'.repeat(2048)}\n\`\`\`\n\nShowing the first 2 KB.`,
    );
    expect(hover('${{ secrets.token }}')?.markdown).toBe(
      `${HEADER}\n\n\`\`\`text\n••••••\n\`\`\`\n\nContains a secret, shown as ••••••.`,
    );
  });

  it('makes the fence longer than any backtick run in the value', () => {
    const output = 'see ```js\nx\n``` and ````';
    const context = {
      ...CONTEXT,
      steps: { ...CONTEXT.steps, tests: { status: 'success' as const, output } },
    };
    expect(hover('${{ steps.tests.output }}', context)?.markdown).toBe(
      `${HEADER}\n\n\`\`\`\`\`text\n${output}\n\`\`\`\`\`\n`.trimEnd(),
    );
  });

  it('reads loop.* from the innermost loop around the block, and from the loop itself in its condition', () => {
    const text = workflowText('${{ steps.tests.output }}');
    const inCheck = text.indexOf('echo ${{ loop.iteration }}') + 8;
    const inUntil = text.indexOf("'${{ loop.iteration }}'") + 4;
    expect(liveValueHover(text, inCheck, CONTEXT, NOW)?.markdown).toBe(`${HEADER}\n\n\`\`\`text\n2\n\`\`\``);
    expect(liveValueHover(text, inUntil, CONTEXT, NOW)?.markdown).toBe(`${HEADER}\n\n\`\`\`text\n2\n\`\`\``);
  });

  it('describes the run in the first line', () => {
    const first = (context: Partial<LiveContext>) =>
      hover('${{ inputs.task }}', { ...CONTEXT, ...context })?.markdown.split('\n')[0];
    expect(first({})).toBe('**Value in the last run** (failed, 4 min ago)');
    expect(first({ status: 'success', startedAt: NOW - 10_000 })).toBe(
      '**Value in the last run** (succeeded, just now)',
    );
    expect(first({ status: 'cancelled', startedAt: NOW - 3 * 60 * MINUTE })).toBe(
      '**Value in the last run** (cancelled, 3 h ago)',
    );
    expect(first({ startedAt: NOW - 24 * 60 * MINUTE })).toBe(
      '**Value in the last run** (failed, 1 day ago)',
    );
    expect(first({ startedAt: NOW - 50 * 60 * MINUTE })).toBe(
      '**Value in the last run** (failed, 2 days ago)',
    );
    expect(first({ simulated: true })).toBe('**Value in the last run** (simulated, failed, 4 min ago)');
    expect(first({ status: 'running' })).toBe('**Value in the running run**');
    expect(first({ status: 'running', simulated: true })).toBe('**Value in the running run** (simulated)');
  });

  it('covers the template from $ to just before the end, and nothing else', () => {
    const template = '${{ steps.tests.output }}';
    const text = workflowText(template);
    const start = text.lastIndexOf(template);
    const end = start + template.length;
    expect(liveValueHover(text, start, CONTEXT, NOW)).toMatchObject({ start, end });
    expect(liveValueHover(text, end - 1, CONTEXT, NOW)).toMatchObject({ start, end });
    expect(liveValueHover(text, end, CONTEXT, NOW)).toBeUndefined();
    expect(liveValueHover(text, start - 1, CONTEXT, NOW)).toBeUndefined();
    expect(liveValueHover(text, text.indexOf('npm test'), CONTEXT, NOW)).toBeUndefined();
  });

  it('finds templates in block scalars and flow mappings', () => {
    const text = [
      'version: 1',
      'name: Review',
      'steps:',
      '  - id: notes',
      '    type: console',
      '    run: |',
      '      echo "${{ steps.tests.exitCode }}"',
      "    env: { TASK: '${{ inputs.task }}' }",
      '',
    ].join('\n');
    const at = (needle: string) => liveValueHover(text, text.indexOf(needle) + 5, CONTEXT, NOW)?.markdown;
    expect(at('${{ steps.tests.exitCode }}')).toBe(`${HEADER}\n\n\`\`\`text\n1\n\`\`\``);
    expect(at('${{ inputs.task }}')).toBe(`${HEADER}\n\n\`\`\`text\nlogin\n\`\`\``);
  });

  it('works in YAML that cannot be parsed, without a block scope', () => {
    const text = 'steps: [\n  run: ${{ inputs.task }} ${{ loop.iteration }}\n';
    const at = (needle: string) => liveValueHover(text, text.indexOf(needle) + 5, CONTEXT, NOW)?.markdown;
    expect(at('${{ inputs.task }}')).toBe(`${HEADER}\n\n\`\`\`text\nlogin\n\`\`\``);
    expect(at('${{ loop.iteration }}')).toBe(`${HEADER}\n\n_loop is only set inside a loop._`);
  });

  it('ignores unterminated templates', () => {
    const text = 'steps:\n  - run: echo ${{ inputs.task\n';
    expect(liveValueHover(text, text.indexOf('inputs'), CONTEXT, NOW)).toBeUndefined();
  });
});
