import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../src/diagnostics';
import type { AgentStep, Step, Workflow } from '../src/schema';
import { validateWorkflow } from '../src/validate';

const agent = (id: string, output: unknown, extra: Partial<AgentStep> = {}): AgentStep =>
  ({ id, type: 'agent', agent: 'coder', prompt: 'Review', output, ...extra }) as AgentStep;
const check = (steps: Step[]) => validateWorkflow({ version: 1, name: 'Test', steps } as Workflow);
const withCode = (diagnostics: Diagnostic[], code: string) => diagnostics.filter((d) => d.code === code);

describe('invalid-output-schema', () => {
  it('reports unknown compact types with the block and the schema path', () => {
    const diagnostics = check([agent('review', { format: 'json', schema: { approved: 'bool' } })]);
    const [d] = withCode(diagnostics, 'invalid-output-schema');
    expect(d).toMatchObject({
      severity: 'error',
      stepId: 'review',
      path: ['steps', 0, 'output', 'schema'],
    });
    expect(d.message).toMatch(/^The output schema of 'review' is invalid: approved: unknown type "bool"\./);
    expect(d.message).toMatch(/Fix output\.schema\.$/);
  });

  it('reports compact types inside a JSON Schema, also in nested blocks', () => {
    const schema = { type: 'object', properties: { approved: 'boolean', score: { type: 'num' } } };
    const steps: Step[] = [
      {
        id: 'l',
        type: 'loop',
        maxIterations: 2,
        steps: [agent('judge', { format: 'json', schema })],
      },
    ];
    const found = withCode(check(steps), 'invalid-output-schema');
    expect(found).toHaveLength(2);
    expect(found.map((d) => d.path)).toEqual([
      ['steps', 0, 'steps', 0, 'output', 'schema'],
      ['steps', 0, 'steps', 0, 'output', 'schema'],
    ]);
    expect(found[0].message).toContain('approved: "boolean" is a compact type');
    expect(found[1].message).toContain('score: unknown JSON Schema type "num"');
  });

  it('accepts valid compact shapes and JSON Schemas', () => {
    const steps = [
      agent('a', { format: 'json', schema: { approved: 'boolean', 'issues?': 'string[]' } }),
      agent('b', { format: 'json', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } }),
      agent('c', { format: 'json' }),
      agent('d', undefined),
    ];
    expect(withCode(check(steps), 'invalid-output-schema')).toEqual([]);
  });

  it('ignores schemas that are not mappings (schema validation reports those)', () => {
    const steps = [agent('a', { format: 'json', schema: 'string' }), agent('b', 'json')];
    expect(withCode(check(steps), 'invalid-output-schema')).toEqual([]);
  });
});

describe('output-schema-without-json', () => {
  it('warns when a schema is set but the output format is text', () => {
    const diagnostics = check([agent('review', { format: 'text', schema: { approved: 'boolean' } })]);
    const [d] = withCode(diagnostics, 'output-schema-without-json');
    expect(d).toMatchObject({
      severity: 'warning',
      stepId: 'review',
      path: ['steps', 0, 'output', 'schema'],
    });
    expect(d.message).toBe(
      "The output schema of 'review' is only used with output format JSON, so it is ignored. " +
        'Switch the output format to JSON or remove the schema.',
    );
  });

  it('also warns when the format is missing, because the agent then answers with text', () => {
    const diagnostics = check([agent('review', { schema: { approved: 'boolean' } })]);
    expect(withCode(diagnostics, 'output-schema-without-json')).toHaveLength(1);
  });

  it('does not report schema problems for text output', () => {
    const diagnostics = check([agent('review', { format: 'text', schema: { approved: 'bool' } })]);
    expect(withCode(diagnostics, 'invalid-output-schema')).toEqual([]);
    expect(withCode(diagnostics, 'output-schema-without-json')).toHaveLength(1);
  });

  it('does not warn for JSON output or when no schema is set', () => {
    const steps = [agent('a', { format: 'json', schema: { ok: 'boolean' } }), agent('b', { format: 'text' })];
    expect(withCode(check(steps), 'output-schema-without-json')).toEqual([]);
  });

  it('names blocks without an id', () => {
    const block = { type: 'agent', agent: 'coder', prompt: 'p', output: { format: 'text', schema: {} } };
    const [d] = withCode(check([block as unknown as Step]), 'output-schema-without-json');
    expect(d.message).toMatch(
      /^The output schema of a block without id is only used with output format JSON/,
    );
    expect(d.stepId).toBeUndefined();
  });
});
