import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Step } from '../../src/schema';
import { applyWorkflowOps, parseWorkflowText, type WorkflowOp } from '../../src/yaml';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name), 'utf8');
const base = fixture('commented.workflow.yaml');

function apply(text: string, ...ops: WorkflowOp[]): string {
  const result = applyWorkflowOps(text, ops);
  if (result.error) throw new Error(result.error);
  return result.text;
}

const errorOf = (text: string, ...ops: WorkflowOp[]) => applyWorkflowOps(text, ops).error;

const lines = (...l: string[]) => l.join('\n') + '\n';

const branchy = lines(
  'version: 1',
  'name: m',
  'steps:',
  '  - id: gate',
  '    type: if',
  '    condition: "${{ true }}"',
  '    then:',
  '      - id: a',
  '        type: break',
  '  - id: b',
  '    type: stop',
);

describe('renameStep reference rewriting', () => {
  const text = lines(
    'version: 1',
    'name: refs',
    'steps:',
    '  - id: tests',
    '    type: console',
    '    run: npm test',
    '  - id: report',
    '    type: agent',
    '    prompt: |',
    '      a ${{ steps.tests.output }}',
    "      b ${{ steps['tests'].exitCode }}",
    '      c ${{ steps["tests"].stdout }}',
    '      d ${{ steps.tests_x.output }} ${{ steps.tests-x.output }}',
    '      e ${{ mysteps.tests }} ${{ x.steps.tests }}',
    '      f ${{ 1 -steps.tests.exitCode }} ${{ steps.tests - 1 }}',
    '  - id: check',
    '    type: if',
    '    condition: steps.tests.exitCode != 0',
    '    then:',
    '      - id: gate',
    '        type: loop',
    '        maxIterations: 2',
    '        until: { value: "${{ steps.tests.exitCode }}", op: eq, to: 0 }',
    '        steps: []',
  );

  it('rewrites dotted and bracketed references in templates and conditions', () => {
    const out = apply(text, { op: 'renameStep', stepId: 'tests', newId: 'checks' });
    expect(out).toBe(
      text
        .replace('- id: tests', '- id: checks')
        .replace('a ${{ steps.tests.output', 'a ${{ steps.checks.output')
        .replace("steps['tests']", "steps['checks']")
        .replace('steps["tests"]', 'steps["checks"]')
        .replace('1 -steps.tests.exitCode', '1 -steps.checks.exitCode')
        .replace('${{ steps.tests - 1', '${{ steps.checks - 1')
        .replace('condition: steps.tests.exitCode', 'condition: steps.checks.exitCode')
        .replace('value: "${{ steps.tests.exitCode', 'value: "${{ steps.checks.exitCode'),
    );
  });

  it('leaves text outside templates and string literals inside expressions alone', () => {
    const source = lines(
      'version: 1',
      'name: plain',
      'description: Renaming steps.tests keeps this sentence',
      'steps:',
      '  - id: tests',
      '    type: console',
      '    run: cat build/steps.tests.log && echo ${{ steps.tests.exitCode }}',
      '  - id: gate',
      '    type: if',
      '    condition:',
      '      any:',
      '        - steps.tests.exitCode != 0',
      "        - not: \"contains(steps[ 'tests' ].output, 'steps.tests')\"",
      '        - { value: steps.tests.exitCode, op: eq, to: "${{ steps.tests.exitCode }}" }',
      '    then: []',
    );
    const out = apply(source, { op: 'renameStep', stepId: 'tests', newId: 'checks' });
    expect(out).toBe(
      lines(
        'version: 1',
        'name: plain',
        'description: Renaming steps.tests keeps this sentence',
        'steps:',
        '  - id: checks',
        '    type: console',
        '    run: cat build/steps.tests.log && echo ${{ steps.checks.exitCode }}',
        '  - id: gate',
        '    type: if',
        '    condition:',
        '      any:',
        '        - steps.checks.exitCode != 0',
        "        - not: \"contains(steps[ 'checks' ].output, 'steps.tests')\"",
        '        - { value: steps.tests.exitCode, op: eq, to: "${{ steps.checks.exitCode }}" }',
        '    then: []',
      ),
    );
  });

  it('treats renaming to the same id as a no-op', () => {
    expect(apply(text, { op: 'renameStep', stepId: 'tests', newId: 'tests' })).toBe(text);
  });

  it('reports unknown blocks', () => {
    expect(errorOf(text, { op: 'renameStep', stepId: 'nope', newId: 'x' })).toBe("Block 'nope' not found");
  });
});

describe('duplicateStep', () => {
  it('rewrites references to renamed blocks inside the copy only', () => {
    const out = apply(base, { op: 'duplicateStep', stepId: 'review_loop' });
    expect(out).toContain('until: "${{ steps.review.json.approved }}"');
    expect(out).toContain('until: "${{ steps.review_2.json.approved }}"');
    expect(out).toContain('prompt: "Review. Tests exited with ${{ steps.tests.exitCode }}."');
    expect(out).toContain('prompt: "Review. Tests exited with ${{ steps.tests_2.exitCode }}."');
  });

  it('rewrites plain expression conditions inside the copy', () => {
    const text = lines(
      'version: 1',
      'name: d',
      'steps:',
      '  - id: l',
      '    type: loop',
      '    maxIterations: 2',
      '    until: steps.t.exitCode == 0',
      '    steps:',
      '      - id: t',
      '        type: console',
      '        run: npm test',
    );
    const out = apply(text, { op: 'duplicateStep', stepId: 'l' });
    expect(out).toContain('    until: steps.t.exitCode == 0\n');
    expect(out).toContain('    until: steps.t_2.exitCode == 0\n');
  });

  it('places the copy right after the original without repeating its leading comment', () => {
    const out = apply(base, { op: 'duplicateStep', stepId: 'implement' });
    expect(out).toContain(
      [
        '  # First, let the coder implement the task.',
        '  - id: implement',
        '    type: agent',
        '    agent: coder',
        '    prompt: |',
        '      Implement in this repository:',
        '      ${{ inputs.task }}',
        '',
        '  - id: implement_2',
        '    type: agent',
        '    agent: coder',
        '    prompt: |',
        '      Implement in this repository:',
        '      ${{ inputs.task }}',
        '',
        '  - id: review_loop',
      ].join('\n'),
    );
    expect(out.match(/First, let the coder/g)).toHaveLength(1);
  });

  it('does not repeat anchors, so later aliases keep pointing at the original', () => {
    const text = lines(
      'version: 1',
      'name: a',
      'steps:',
      '  - id: a',
      '    type: console',
      '    run: &cmd npm test',
      '  - id: b',
      '    type: console',
      '    run: *cmd',
    );
    const out = apply(text, { op: 'duplicateStep', stepId: 'a' });
    expect(out).toContain('  - id: a_2\n    type: console\n    run: npm test\n');
    expect(out.match(/&cmd/g)).toHaveLength(1);
  });

  it('counts up from a numeric suffix instead of stacking suffixes', () => {
    const text = lines(
      'version: 1',
      'name: d',
      'steps:',
      '  - id: agent_1',
      '    type: break',
      '  - id: agent_2',
      '    type: break',
    );
    const out = apply(text, { op: 'duplicateStep', stepId: 'agent_1' });
    expect(parseWorkflowText(out).workflow?.steps.map((s) => s.id)).toEqual([
      'agent_1',
      'agent_3',
      'agent_2',
    ]);
  });
});

describe('moveStep', () => {
  it('creates an else list on demand and removes it again when it empties', () => {
    const moved = apply(branchy, {
      op: 'moveStep',
      stepId: 'b',
      target: { parentId: 'gate', slot: 'else', index: 0 },
    });
    expect(moved).toContain(
      '    then:\n      - id: a\n        type: break\n    else:\n      - id: b\n        type: stop\n',
    );
    const back = apply(moved, {
      op: 'moveStep',
      stepId: 'b',
      target: { parentId: null, slot: 'steps', index: 1 },
    });
    expect(back).toBe(branchy);
  });

  it('refuses moves into descendants', () => {
    const text = apply(base, {
      op: 'insertStep',
      target: { parentId: 'review_loop', slot: 'steps', index: 2 },
      step: { id: 'check', type: 'if', condition: '${{ true }}', then: [] },
    });
    expect(
      errorOf(text, {
        op: 'moveStep',
        stepId: 'review_loop',
        target: { parentId: 'check', slot: 'then', index: 0 },
      }),
    ).toBe('Cannot move a block into itself or one of its children');
  });

  it('reports unknown blocks and parents', () => {
    expect(
      errorOf(base, { op: 'moveStep', stepId: 'nope', target: { parentId: null, slot: 'steps', index: 0 } }),
    ).toBe("Block 'nope' not found");
    expect(
      errorOf(base, {
        op: 'moveStep',
        stepId: 'tests',
        target: { parentId: 'nope', slot: 'steps', index: 0 },
      }),
    ).toBe("Parent block 'nope' not found");
  });

  it('keeps a list header comment that is separated from the first block by a blank line', () => {
    const text = lines(
      'version: 1',
      'name: h',
      'steps:',
      '  # Blocks run from top to bottom.',
      '',
      '  # About a.',
      '  - id: a',
      '    type: break',
      '  - id: b',
      '    type: break',
    );
    expect(apply(text, { op: 'updateWorkflow', set: {} })).toBe(text);
    const moved = apply(text, {
      op: 'moveStep',
      stepId: 'a',
      target: { parentId: null, slot: 'steps', index: 2 },
    });
    expect(moved).toBe(
      lines(
        'version: 1',
        'name: h',
        'steps:',
        '  # Blocks run from top to bottom.',
        '',
        '  - id: b',
        '    type: break',
        '  # About a.',
        '  - id: a',
        '    type: break',
      ),
    );
    const header = lines('version: 1', 'name: h', 'steps:', '  # Header', '', '  - id: a', '    type: break');
    expect(apply(header, { op: 'deleteStep', stepId: 'a' })).toContain('# Header');
  });

  it('keeps blank-line separation consistent and never leaves whitespace-only lines', () => {
    const out = apply(base, {
      op: 'moveStep',
      stepId: 'review_loop',
      target: { parentId: null, slot: 'steps', index: 0 },
    });
    expect(out).toContain('steps:\n  - id: review_loop\n');
    expect(out).toContain('\n\n  # First, let the coder implement the task.\n  - id: implement\n');
    expect(out).not.toMatch(/[ \t]+$/m);
  });
});

describe('insertStep validation', () => {
  const ins = (parentId: string | null, slot: 'steps' | 'then' | 'else', id = 'x'): WorkflowOp => ({
    op: 'insertStep',
    target: { parentId, slot, index: 0 },
    step: { id, type: 'break' },
  });

  it('refuses parents that cannot contain blocks', () => {
    expect(errorOf(base, ins('tests', 'steps'))).toBe("Block 'tests' cannot contain blocks");
    expect(errorOf(base, ins('review_loop', 'then'))).toBe(
      "Block 'review_loop' cannot contain blocks in 'then'. Use 'steps'.",
    );
    expect(errorOf(base, ins(null, 'else'))).toMatch(/top-level blocks/);
  });

  it('validates ids, including nested ones', () => {
    expect(errorOf(base, ins(null, 'steps', '9x'))).toMatch(/Block ids start with a letter/);
    expect(
      errorOf(base, {
        op: 'insertStep',
        target: { parentId: null, slot: 'steps', index: 0 },
        step: { id: 'outer', type: 'loop', maxIterations: 2, steps: [{ id: 'review', type: 'break' }] },
      }),
    ).toBe("A block with id 'review' already exists");
  });

  it('creates the steps list when the workflow has none', () => {
    const out = apply('version: 1\nname: x\n', ins(null, 'steps', 'first'));
    expect(out).toBe('version: 1\nname: x\nsteps:\n  - id: first\n    type: break\n');
    expect(apply('version: 1\nname: x\nsteps:\n', ins(null, 'steps', 'first'))).toBe(out);
    expect(apply('', ins(null, 'steps', 'first'))).toBe('steps:\n  - id: first\n    type: break\n');
  });

  it('refuses lists that are not lists and blocks that are not mappings', () => {
    const text = lines(
      'version: 1',
      'name: x',
      'steps:',
      '  - id: gate',
      '    type: if',
      '    condition: x',
      '    then: nope',
    );
    expect(errorOf(text, ins('gate', 'then'))).toBe(
      "'then' must be a list of blocks. Fix it in the YAML first.",
    );
    expect(
      errorOf(base, {
        op: 'insertStep',
        target: { parentId: null, slot: 'steps', index: 0 },
        step: 'break' as unknown as Step,
      }),
    ).toBe('The block to insert must be a mapping with at least id and type');
  });

  it('quotes new template strings and writes short file lists compactly', () => {
    const out = apply('version: 1\nname: x\nsteps: []\n', {
      op: 'insertStep',
      target: { parentId: null, slot: 'steps', index: 0 },
      step: {
        id: 'a',
        type: 'agent',
        prompt: 'Implement ${{ inputs.task }}',
        context: { files: ['src/**/*.ts', 'README.md'] },
      },
    });
    expect(out).toContain(
      '    prompt: "Implement ${{ inputs.task }}"\n    context:\n      files: [src/**/*.ts, README.md]\n',
    );
    expect(parseWorkflowText(out).workflow?.steps[0]).toMatchObject({
      context: { files: ['src/**/*.ts', 'README.md'] },
    });
  });

  it('adds blank lines between top-level blocks when the list uses them', () => {
    const out = apply(base, ins(null, 'steps', 'first'));
    expect(out).toContain(
      'steps:\n  - id: first\n    type: break\n\n  # First, let the coder implement the task.\n  - id: implement\n',
    );
  });
});

describe('updateStep', () => {
  it('replaces an expression with a structured condition written compactly', () => {
    const out = apply(base, {
      op: 'updateStep',
      stepId: 'review_loop',
      set: {
        until: {
          all: [
            { value: '${{ steps.tests.exitCode }}', op: 'eq', to: 0 },
            { op: 'isTrue', value: '${{ steps.review.json.approved }}' },
          ],
        },
      },
    });
    expect(out).toContain(
      [
        '    maxIterations: 5 # keep this low, tokens are expensive',
        '    until:',
        '      all:',
        '        - { value: "${{ steps.tests.exitCode }}", op: eq, to: 0 }',
        '        - { value: "${{ steps.review.json.approved }}", op: isTrue }',
        '    steps:',
      ].join('\n'),
    );
    expect(parseWorkflowText(out).valid).toBe(true);
  });

  it('updates nested values in place, keeping comments inside them', () => {
    const text = lines(
      'version: 1',
      'name: c',
      'steps:',
      '  - id: l',
      '    type: loop',
      '    maxIterations: 2',
      '    until:',
      '      any:',
      '        # tests pass',
      '        - value: "${{ steps.t.exitCode }}"',
      '          op: eq',
      '          to: 0 # zero means success',
      '    steps: []',
    );
    const out = apply(text, {
      op: 'updateStep',
      stepId: 'l',
      set: { until: { any: [{ value: '${{ steps.t.exitCode }}', op: 'lte', to: 1 }] } },
    });
    expect(out).toBe(text.replace('op: eq', 'op: lte').replace('to: 0 #', 'to: 1 #'));
  });

  it('writes new multi-line values as block scalars', () => {
    const out = apply(base, { op: 'updateStep', stepId: 'tests', set: { run: 'npm ci\nnpm test' } });
    expect(out).toContain(
      '        run: |-\n          npm ci\n          npm test\n        continueOnError: true\n',
    );
  });

  it('writes inline agent tool lists in flow style', () => {
    const out = apply(base, {
      op: 'updateStep',
      stepId: 'implement',
      set: {
        agent: { model: 'litellm/gpt-4.1', tools: ['readFile', 'editFile'], permissions: { edits: 'auto' } },
      },
    });
    expect(out).toContain(
      '    agent:\n      model: litellm/gpt-4.1\n      tools: [readFile, editFile]\n      permissions: { edits: auto }\n',
    );
    expect(parseWorkflowText(out).valid).toBe(true);
  });

  it('keeps the bracket padding of untouched flow collections', () => {
    const text = lines(
      'version: 1',
      'name: p',
      'steps:',
      '  - id: a',
      '    type: agent',
      '    prompt: hi',
      '    agent: {model: litellm/x, tools: [readFile, gitDiff]}',
      '    context: { files: [ "src/**" ] }',
    );
    const out = apply(text, { op: 'updateStep', stepId: 'a', set: { prompt: 'hello' } });
    expect(out).toBe(text.replace('prompt: hi', 'prompt: hello'));
    const dup = apply(text, { op: 'duplicateStep', stepId: 'a' });
    expect(dup.match(/agent: \{model: litellm\/x, tools: \[readFile, gitDiff\]\}/g)).toHaveLength(2);
  });

  it('validates ids of replaced block lists', () => {
    const text = apply(base, {
      op: 'insertStep',
      target: { parentId: null, slot: 'steps', index: 2 },
      step: { id: 'gate', type: 'if', condition: 'true', then: [{ id: 'inner', type: 'break' }] },
    });
    expect(
      errorOf(text, { op: 'updateStep', stepId: 'gate', set: { then: [{ id: 'tests', type: 'break' }] } }),
    ).toBe("A block with id 'tests' already exists");
    const out = apply(text, {
      op: 'updateStep',
      stepId: 'gate',
      set: { then: [{ id: 'inner', type: 'stop' }] },
    });
    expect(out).toContain('    then:\n      - id: inner\n        type: stop\n');
  });

  it('ignores unsetting keys that do not exist', () => {
    expect(apply(base, { op: 'updateStep', stepId: 'tests', set: {}, unset: ['timeout'] })).toBe(base);
  });
});

describe('updateWorkflow', () => {
  it('refuses to replace the block list', () => {
    expect(errorOf(base, { op: 'updateWorkflow', set: { steps: [] } })).toMatch(/insertStep/);
  });

  it('updates nested input definitions in place and removes keys', () => {
    const out = apply(base, {
      op: 'updateWorkflow',
      set: { inputs: { task: { type: 'string', description: 'What to build?', required: true } } },
      unset: ['nothing'],
    });
    expect(out).toContain(
      'inputs:\n  task:\n    type: string\n    description: What to build?\n    required: true\n\nsteps:',
    );
  });
});

describe('document handling', () => {
  it('refuses to edit text with YAML errors and returns it unchanged', () => {
    const broken = 'version: 1\nname: "x\n';
    const result = applyWorkflowOps(broken, [{ op: 'deleteStep', stepId: 'a' }]);
    expect(result.text).toBe(broken);
    expect(result.error).toMatch(/^The workflow file has YAML errors/);
  });

  it('refuses non-mapping documents', () => {
    expect(errorOf('- a\n', { op: 'deleteStep', stepId: 'a' })).toMatch(/mapping/);
  });

  it('keeps CRLF line endings and a byte order mark', () => {
    const text = '﻿' + branchy.replace(/\n/g, '\r\n');
    const out = apply(text, { op: 'deleteStep', stepId: 'b' });
    expect(out.startsWith('﻿version: 1\r\n')).toBe(true);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out).toBe('﻿' + branchy.replace('  - id: b\n    type: stop\n', '').replace(/\n/g, '\r\n'));
  });

  it('does not count the byte order mark when detecting the indentation', () => {
    const text = '﻿steps:\n  - id: a\n    type: break\nversion: 1\nname: x\n';
    expect(apply(text, { op: 'updateWorkflow', set: { name: 'y' } })).toBe(
      text.replace('name: x', 'name: y'),
    );
  });

  it('leaves empty and comment-only files alone when nothing changes', () => {
    expect(applyWorkflowOps('', [])).toEqual({ text: '' });
    expect(applyWorkflowOps('# draft\n', [])).toEqual({ text: '# draft\n' });
    expect(applyWorkflowOps('\n', [{ op: 'updateWorkflow', set: {} }])).toEqual({ text: '\n' });
  });

  it('writes multi-line values with CRLF line breaks as block scalars', () => {
    const set = { prompt: 'Line one\r\nLine two\r\n' };
    const out = apply(base, { op: 'updateStep', stepId: 'review', set });
    expect(out).toContain('        prompt: |\n          Line one\n          Line two\n');
    const crlf = apply(base.replace(/\n/g, '\r\n'), { op: 'updateStep', stepId: 'review', set });
    expect(crlf).not.toContain('\r\r');
    expect(crlf).toBe(out.replace(/\n/g, '\r\n'));
    const inserted = apply('version: 1\nname: x\nsteps: []\n', {
      op: 'insertStep',
      target: { parentId: null, slot: 'steps', index: 0 },
      step: { id: 'a', type: 'console', run: 'npm ci\r\nnpm test' },
    });
    expect(inserted).toContain('    run: |-\n      npm ci\n      npm test\n');
  });

  it('writes an emptied list with a trailing comment as [] on the key line', () => {
    const text = lines(
      'version: 1',
      'name: x',
      'steps:',
      '  - id: a',
      '    type: break',
      '  # more later',
      'env: {}',
    );
    const out = apply(text, { op: 'deleteStep', stepId: 'a' });
    expect(out).toBe(lines('version: 1', 'name: x', 'steps: [] # more later', 'env: {}'));
    expect(parseWorkflowText(out).valid).toBe(true);
    const refilled = apply(out, {
      op: 'insertStep',
      target: { parentId: null, slot: 'steps', index: 0 },
      step: { id: 'b', type: 'break' },
    });
    expect(refilled).toContain('steps:\n  - id: b\n    type: break\n');
  });

  it('keeps non-indented sequences and wider indentation', () => {
    const flat = 'version: 1\nname: f\nsteps:\n- id: a\n  type: break\n';
    expect(
      apply(flat, {
        op: 'insertStep',
        target: { parentId: null, slot: 'steps', index: 1 },
        step: { id: 'b', type: 'break' },
      }),
    ).toBe(flat + '- id: b\n  type: break\n');
    const wide =
      'version: 1\nname: w\ninputs:\n    task:\n        type: string\nsteps:\n    - id: a\n      type: break\n';
    expect(apply(wide, { op: 'updateWorkflow', set: { description: 'd' } })).toBe(
      wide.replace('name: w\n', 'name: w\ndescription: d\n'),
    );
  });

  it('reports unknown operations', () => {
    expect(errorOf(base, { op: 'teleport' } as unknown as WorkflowOp)).toBe("Unknown operation 'teleport'");
  });
});
