import { describe, expect, it } from 'vitest';
import type { Workflow } from '@isar-flow/core';
import { resolveCliInputs } from '../src/inputs';

const workflow = (inputs: Workflow['inputs']): Workflow => ({ version: 1, name: 'W', inputs, steps: [] });

describe('resolveCliInputs', () => {
  const declared = workflow({
    branch: { type: 'string', required: true },
    count: { type: 'number', default: 3 },
    dryRun: { type: 'boolean' },
    note: { type: 'string' },
  });

  it('turns text values into the declared types and applies defaults', () => {
    expect(resolveCliInputs(declared, { branch: 'main', dryRun: 'yes' })).toEqual({
      inputs: { branch: 'main', count: 3, dryRun: true },
      warnings: [],
    });
    expect(resolveCliInputs(declared, { branch: 'x', count: ' 7 ', dryRun: 'OFF' }).inputs).toEqual({
      branch: 'x',
      count: 7,
      dryRun: false,
    });
  });

  it('says how to pass a missing required input', () => {
    expect(() => resolveCliInputs(declared, {})).toThrow(
      "Input 'branch' is required. Pass --input branch=value.",
    );
    expect(() => resolveCliInputs(declared, { branch: '' })).toThrow(
      "Input 'branch' is required. Pass --input branch=value.",
    );
  });

  it('refuses values that are not numbers or yes/no values', () => {
    expect(() => resolveCliInputs(declared, { branch: 'x', count: 'many' })).toThrow(
      "Input 'count' must be a number, but got 'many'.",
    );
    expect(() => resolveCliInputs(declared, { branch: 'x', dryRun: 'maybe' })).toThrow(
      "Input 'dryRun' must be true or false, but got 'maybe'.",
    );
  });

  it('warns about inputs the workflow does not declare and passes them on', () => {
    const result = resolveCliInputs(declared, { branch: 'x', colour: 'red' });
    expect(result.inputs.colour).toBe('red');
    expect(result.warnings).toEqual([
      "The workflow has no input 'colour'; it is passed on anyway. Its inputs are branch, count, dryRun and note.",
    ]);
    expect(resolveCliInputs(workflow(undefined), { a: '1' }).warnings).toEqual([
      "The workflow has no input 'a'; it is passed on anyway. It declares no inputs.",
    ]);
  });
});
