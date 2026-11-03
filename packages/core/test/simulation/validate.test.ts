import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../../src/diagnostics';
import type { SimulationFile, Workflow } from '../../src/schema/types';
import { checkSimulationText, validateSimulation } from '../../src/simulation';

const workflow: Workflow = {
  version: 1,
  name: 'Mocks',
  steps: [
    { id: 'implement', type: 'agent', agent: 'coder', prompt: 'Implement' },
    {
      id: 'review_loop',
      type: 'loop',
      maxIterations: 5,
      until: '${{ steps.review.json.approved }}',
      steps: [
        { id: 'tests', type: 'console', run: 'npm test' },
        {
          id: 'review',
          type: 'agent',
          prompt: 'Review',
          output: { format: 'json', schema: { approved: 'boolean', issues: 'string[]' } },
        },
        {
          id: 'gate',
          type: 'if',
          condition: '${{ true }}',
          then: [{ id: 'leave', type: 'break' }],
        },
      ],
    },
    { id: 'ship', type: 'approval', message: 'Ship?' },
    { id: 'end', type: 'stop' },
    {
      id: 'classify',
      type: 'agent',
      prompt: 'Classify',
      output: {
        format: 'json',
        schema: {
          type: 'object',
          required: ['level'],
          properties: {
            level: { type: 'string', enum: ['low', 'high'] },
            meta: { type: 'object', properties: { n: { type: 'number' } } },
          },
        },
      },
    },
    { id: 'loose', type: 'agent', prompt: 'x', output: { format: 'json' } },
    { id: 'broken_shape', type: 'agent', prompt: 'x', output: { format: 'json', schema: { ok: 'bool' } } },
  ],
};

const messages = (file: SimulationFile) => validateSimulation(file, workflow).map((d) => d.message);

describe('validateSimulation', () => {
  it('accepts mocks that fit their blocks', () => {
    const file: SimulationFile = {
      version: 1,
      approvals: 'reject',
      blocks: {
        tests: [{ exitCode: 1, output: '1 failed' }, { exitCode: 0 }, { error: 'No shell' }],
        review: [
          { json: { approved: false, issues: ['x'] } },
          { text: 'Looks good: {"approved": true, "issues": []}' },
          { json: { approved: true, issues: [] }, text: 'Approved' },
          {},
          { error: 'The model is not reachable.' },
        ],
        implement: [{ text: 'Done' }],
        ship: [{ approved: false, comment: 'Not yet' }],
        classify: [{ json: { level: 'low', meta: { n: 1 } } }],
        loose: [{ json: [1, 2] }],
        broken_shape: [{ json: { ok: 'yes' } }],
      },
    };
    expect(validateSimulation(file, workflow)).toEqual([]);
    expect(validateSimulation({}, workflow)).toEqual([]);
  });

  it('warns about unknown block ids with the key range', () => {
    const range = { start: { line: 3, character: 2 }, end: { line: 3, character: 6 } };
    expect(validateSimulation({ blocks: { lint: [{ exitCode: 0 }] } }, workflow, { lint: range })).toEqual<
      Diagnostic[]
    >([
      {
        severity: 'warning',
        code: 'sim-unknown-block',
        message: 'No block "lint" in this workflow. Remove its mocks or fix the id.',
        path: ['blocks', 'lint'],
        range,
        stepId: 'lint',
      },
    ]);
  });

  it('warns about mocks for blocks that make no host calls', () => {
    const diagnostics = validateSimulation(
      { blocks: { review_loop: [{}], gate: [{}], leave: [{}], end: [{}] } },
      workflow,
    );
    expect(diagnostics.map((d) => [d.code, d.stepId, d.message])).toEqual([
      [
        'sim-no-host-call',
        'review_loop',
        '"review_loop" is a loop block; only console, agent and approval blocks use mocks.',
      ],
      [
        'sim-no-host-call',
        'gate',
        '"gate" is an if block; only console, agent and approval blocks use mocks.',
      ],
      [
        'sim-no-host-call',
        'leave',
        '"leave" is a break block; only console, agent and approval blocks use mocks.',
      ],
      [
        'sim-no-host-call',
        'end',
        '"end" is a stop block; only console, agent and approval blocks use mocks.',
      ],
    ]);
    expect(diagnostics[0]).not.toHaveProperty('range');
  });

  it('warns about fields of other block types', () => {
    expect(
      messages({
        blocks: {
          tests: [{ exitCode: 0 }, { text: 'x', approved: true }],
          implement: [{ exitCode: 0, output: 'x' }],
          ship: [{ output: 'x', comment: 'ok' }],
        },
      }),
    ).toEqual([
      'Result 2 of "tests": text doesn\'t apply to console blocks. Use exitCode and output.',
      'Result 2 of "tests": approved doesn\'t apply to console blocks. Use exitCode and output.',
      'Result 1 of "implement": exitCode doesn\'t apply to agent blocks. Use text, or json for JSON answers.',
      'Result 1 of "implement": output doesn\'t apply to agent blocks. Use text, or json for JSON answers.',
      'Result 1 of "ship": output doesn\'t apply to approval blocks. Use approved and comment.',
    ]);
    const [first] = validateSimulation({ blocks: { tests: [{ text: 'x' }] } }, workflow);
    expect(first).toMatchObject({ code: 'sim-field-mismatch', path: ['blocks', 'tests', 0, 'text'] });
  });

  it('warns about json for text agents', () => {
    const diagnostics = validateSimulation(
      { blocks: { implement: [{ text: 'a' }, { json: {} }] } },
      workflow,
    );
    expect(diagnostics).toMatchObject([
      {
        code: 'sim-field-mismatch',
        message: 'Result 2 of "implement": this agent answers with text, so json is ignored. Use text.',
        stepId: 'implement',
      },
    ]);
  });

  it('checks JSON answers against the JSON fields', () => {
    expect(
      messages({
        blocks: {
          review: [
            { json: { approved: 'yes' } },
            { text: '{"approved": 1, "issues": []}' },
            { text: 'not JSON at all' },
          ],
          classify: [{ json: { level: 'mid', meta: { n: 'x' } } }, { json: { meta: {} } }],
        },
      }),
    ).toEqual([
      'Result 1 of "review" doesn\'t match the JSON fields: approved: expected boolean, got string "yes"; ' +
        'issues: missing (expected string[]).',
      'Result 2 of "review" doesn\'t match the JSON fields: approved: expected boolean, got number 1.',
      'Result 3 of "review": this agent answers with JSON, but the text isn\'t JSON. Use json, or write the text as JSON.',
      'Result 1 of "classify" doesn\'t match the JSON fields: level: expected one of "low", "high", got string "mid"; ' +
        'meta.n: expected number, got string "x".',
      'Result 2 of "classify" doesn\'t match the JSON fields: level: missing (expected string).',
    ]);
    const [first] = validateSimulation({ blocks: { review: [{ json: 1 }] } }, workflow);
    expect(first).toMatchObject({
      code: 'sim-json-shape',
      path: ['blocks', 'review', 0],
      severity: 'warning',
    });
  });
});

describe('checkSimulationText', () => {
  const text = [
    'version: 1',
    'blocks:',
    '  lint:',
    '    - exitCode: 0',
    '  tests:',
    '    - text: hi',
    '',
  ].join('\n');

  it('parses and validates against the workflow', () => {
    const result = checkSimulationText(text, workflow);
    expect(result.file).toEqual({ version: 1, blocks: { lint: [{ exitCode: 0 }], tests: [{ text: 'hi' }] } });
    expect(result.diagnostics.map((d) => [d.code, d.range?.start.line])).toEqual([
      ['sim-unknown-block', 2],
      ['sim-field-mismatch', 4],
    ]);
  });

  it('only parses without a workflow', () => {
    expect(checkSimulationText(text, null).diagnostics).toEqual([]);
  });

  it('returns an empty file when the text has errors', () => {
    const result = checkSimulationText('blocks: [\n', workflow);
    expect(result.file).toEqual({});
    expect(result.diagnostics[0].code).toBe('yaml-syntax');
  });
});
