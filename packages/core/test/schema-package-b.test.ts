import { describe, expect, it } from 'vitest';
import { SimulationFileSchema, SimulationResultSchema, simulationJsonSchema } from '../src/schema';

describe('simulation file schema', () => {
  it('accepts mocks for console, agent and approval blocks', () => {
    const file = {
      version: 1,
      approvals: 'reject',
      blocks: {
        tests: [{ exitCode: 1, output: '1 failed' }, { exitCode: 0 }],
        review: [{ json: { approved: false, issues: ['x'] } }, { json: { approved: true, issues: [] } }],
        ship_it: [{ approved: true, comment: 'Looks good' }],
        implement: [{ error: 'The model is not reachable.' }],
      },
    };
    expect(SimulationFileSchema.safeParse(file).success).toBe(true);
    expect(SimulationFileSchema.safeParse({}).success).toBe(true);
  });

  it('rejects unknown keys, wrong types and invalid block ids', () => {
    expect(SimulationFileSchema.safeParse({ blocks: { tests: [{ exitcode: 1 }] } }).success).toBe(false);
    expect(SimulationFileSchema.safeParse({ blocks: { tests: { exitCode: 1 } } }).success).toBe(false);
    expect(SimulationFileSchema.safeParse({ blocks: { '1tests': [] } }).success).toBe(false);
    expect(SimulationFileSchema.safeParse({ approvals: 'yes' }).success).toBe(false);
    expect(SimulationFileSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(SimulationResultSchema.safeParse({ exitCode: 1.5 }).success).toBe(false);
    expect(SimulationResultSchema.safeParse({ error: '' }).success).toBe(false);
  });

  it('has a JSON schema for the YAML extension', () => {
    const schema = simulationJsonSchema() as { title: string; properties: Record<string, unknown> };
    expect(schema.title).toBe('Isar Flow simulation mocks');
    expect(Object.keys(schema.properties)).toEqual(['version', 'approvals', 'blocks']);
  });
});
