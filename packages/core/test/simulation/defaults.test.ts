import { describe, expect, it } from 'vitest';
import type { Step } from '../../src/schema/types';
import { defaultSimulationResult, sampleJson, SIMULATED_ANSWER } from '../../src/simulation';

describe('sampleJson', () => {
  it('builds an object without a shape', () => {
    expect(sampleJson(undefined)).toEqual({});
  });

  it('fills compact shapes, optional keys included', () => {
    expect(
      sampleJson({
        approved: 'boolean',
        issues: 'string[]',
        score: 'number',
        count: 'integer?',
        'note?': 'string',
        meta: { owner: 'string', tags: ['string'] },
        anything: 'any',
      }),
    ).toEqual({
      approved: true,
      issues: [],
      score: 0,
      count: 0,
      note: '(simulated)',
      meta: { owner: '(simulated)', tags: [] },
      anything: null,
    });
  });

  it('fills JSON Schemas: const, default and enum win, unions take the first option', () => {
    expect(
      sampleJson({
        type: 'object',
        required: ['verdict'],
        properties: {
          verdict: { type: 'string', enum: ['approve', 'reject'] },
          kind: { const: 'review' },
          level: { type: 'integer', default: 3, enum: [1, 2, 3] },
          nested: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, nothing: { type: 'null' } },
          },
          either: { anyOf: [{ type: 'number' }, { type: 'string' }] },
          one: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          nullable: { type: ['null', 'string'] },
          list: { type: 'array', items: { type: 'string' } },
          implicit: { properties: { a: { type: 'string' } } },
          implicitList: { items: { type: 'string' } },
          free: {},
          flag: true,
          mystery: { type: 'date' },
        },
      }),
    ).toEqual({
      verdict: 'approve',
      kind: 'review',
      level: 3,
      nested: { ok: true, nothing: null },
      either: 0,
      one: '(simulated)',
      nullable: null,
      list: [],
      implicit: { a: '(simulated)' },
      implicitList: [],
      free: null,
      flag: null,
      mystery: null,
    });
  });

  it('samples schemas whose root is not an object', () => {
    expect(sampleJson({ type: 'array', items: { type: 'string' } })).toEqual([]);
    expect(sampleJson({ type: 'string' })).toBe('(simulated)');
    expect(sampleJson({ type: 'number' })).toBe(0);
  });
});

describe('defaultSimulationResult', () => {
  const console: Step = { id: 'tests', type: 'console', run: 'npm test' };
  const textAgent: Step = { id: 'impl', type: 'agent', prompt: 'Do it' };
  const jsonAgent: Step = {
    id: 'review',
    type: 'agent',
    prompt: 'Review',
    output: { format: 'json', schema: { approved: 'boolean', issues: 'string[]' } },
  };
  const approval: Step = { id: 'ship', type: 'approval', message: 'Ship?' };

  it('gives each block type its default', () => {
    expect(defaultSimulationResult(console)).toEqual({ exitCode: 0, output: '' });
    expect(defaultSimulationResult(textAgent)).toEqual({ text: SIMULATED_ANSWER });
    expect(defaultSimulationResult({ ...textAgent, output: { format: 'text' } })).toEqual({
      text: SIMULATED_ANSWER,
    });
    expect(defaultSimulationResult(jsonAgent)).toEqual({
      json: { approved: true, issues: [] },
      text: '{\n  "approved": true,\n  "issues": []\n}',
    });
    expect(defaultSimulationResult({ ...jsonAgent, output: { format: 'json' } })).toEqual({
      json: {},
      text: '{}',
    });
    expect(defaultSimulationResult(approval)).toEqual({ approved: true });
    expect(defaultSimulationResult(approval, 'approve')).toEqual({ approved: true });
    expect(defaultSimulationResult(approval, 'reject')).toEqual({ approved: false });
    expect(defaultSimulationResult({ id: 'l', type: 'loop', maxIterations: 2, steps: [] })).toEqual({});
    expect(defaultSimulationResult({ id: 'b', type: 'break' })).toEqual({});
    expect(SIMULATED_ANSWER).toBe('(simulated answer)');
  });
});
