import { describe, expect, it } from 'vitest';
import { blockHash, blockHashes } from '../../src/run';
import type { Step, Workflow } from '../../src/schema/types';

const lenient = (value: Record<string, unknown>) => value as unknown as Step;

describe('blockHash', () => {
  const tests: Step = { id: 'tests', type: 'console', run: 'npm test', env: { CI: '1', LANG: 'en' } };

  it('returns 14 lowercase hex characters', () => {
    expect(blockHash(tests)).toMatch(/^[0-9a-f]{14}$/);
    expect(blockHash({ id: 'b', type: 'break' })).toMatch(/^[0-9a-f]{14}$/);
  });

  it('keeps stored hashes valid: the algorithm and the JSON text must not change', () => {
    expect(blockHash(tests)).toBe(blockHash(tests));
    // cyrb53 of '{"id":"a","run":"echo a","type":"console"}' (reference implementation by bryc).
    expect(blockHash({ id: 'a', type: 'console', run: 'echo a' })).toBe('13df827c1dfc83');
  });

  it('does not depend on key order, also in nested objects', () => {
    const reordered = lenient({
      env: { LANG: 'en', CI: '1' },
      run: 'npm test',
      type: 'console',
      id: 'tests',
    });
    expect(blockHash(reordered)).toBe(blockHash(tests));
  });

  it('ignores the display name', () => {
    expect(blockHash({ ...tests, name: 'Run the tests' })).toBe(blockHash(tests));
  });

  it('changes when the block itself changes', () => {
    const agent: Step = { id: 'plan', type: 'agent', model: 'p/m', prompt: 'Plan the work' };
    expect(blockHash({ ...agent, prompt: 'Plan the work.' })).not.toBe(blockHash(agent));
    expect(blockHash({ ...agent, id: 'plan2' })).not.toBe(blockHash(agent));
    expect(blockHash({ ...tests, env: { CI: '0', LANG: 'en' } })).not.toBe(blockHash(tests));
  });

  it('keeps the order of lists', () => {
    const agent: Step = { id: 'a', type: 'agent', model: 'p/m', prompt: 'x', context: { files: ['a', 'b'] } };
    expect(blockHash({ ...agent, context: { files: ['b', 'a'] } })).not.toBe(blockHash(agent));
  });

  it('ignores the blocks inside a loop but not its own settings', () => {
    const loop: Step = {
      id: 'l',
      type: 'loop',
      until: '${{ steps.t.exitCode == 0 }}',
      maxIterations: 3,
      steps: [{ id: 't', type: 'console', run: 'test' }],
    };
    const otherChildren: Step = { ...loop, steps: [{ id: 't', type: 'console', run: 'other' }] };
    expect(blockHash(otherChildren)).toBe(blockHash(loop));
    expect(blockHash({ ...loop, steps: [] })).toBe(blockHash(loop));
    expect(blockHash({ ...loop, maxIterations: 4 })).not.toBe(blockHash(loop));
  });

  it('ignores the branches of an if but not its condition', () => {
    const branch: Step = {
      id: 'gate',
      type: 'if',
      condition: '${{ steps.t.exitCode == 0 }}',
      then: [{ id: 'ok', type: 'console', run: 'ok' }],
      else: [{ id: 'fix', type: 'console', run: 'fix' }],
    };
    expect(blockHash({ ...branch, then: [], else: undefined })).toBe(blockHash(branch));
    expect(blockHash({ ...branch, condition: '${{ steps.t.exitCode == 1 }}' })).not.toBe(blockHash(branch));
  });

  it('keeps the content of keys that are only child lists for loops and ifs', () => {
    const odd = lenient({ id: 'p', type: 'parallel', steps: [{ id: 'x' }] });
    expect(blockHash(lenient({ id: 'p', type: 'parallel', steps: [{ id: 'y' }] }))).not.toBe(blockHash(odd));
  });

  it('tolerates lenient values', () => {
    const cyclic: Record<string, unknown> = { id: 'c', type: 'console' };
    cyclic.self = cyclic;
    const values = [
      lenient({ id: 'x', type: 'console', run: null, extra: [1, undefined, Number.NaN, Infinity], big: 10n }),
      lenient({ id: 'x', type: 'console', run: 42, fn: () => 1, sym: Symbol('s') }),
      lenient(JSON.parse('{ "id": "x", "__proto__": { "a": 1 } }') as Record<string, unknown>),
      lenient({ id: 7, type: 7 }),
      lenient({}),
      lenient(cyclic),
    ];
    for (const value of values) expect(blockHash(value)).toMatch(/^[0-9a-f]{14}$/);
    expect(blockHash(lenient({ id: 'x', a: undefined }))).toBe(blockHash(lenient({ id: 'x' })));
    // Like JSON: functions and symbols are left out; a "__proto__" key is ordinary content.
    expect(blockHash(values[1])).toBe(blockHash(lenient({ id: 'x', type: 'console', run: 42 })));
    expect(blockHash(values[2])).not.toBe(blockHash(lenient({ id: 'x' })));
    expect(blockHash(lenient({ id: 'x', a: [undefined] }))).toBe(blockHash(lenient({ id: 'x', a: [null] })));
  });
});

describe('blockHashes', () => {
  const inner: Step = { id: 'fix', type: 'console', run: 'fix' };
  const ok: Step = { id: 'ok', type: 'console', run: 'ok' };
  const gate: Step = { id: 'gate', type: 'if', condition: 'true', then: [ok], else: [inner] };
  const loop: Step = { id: 'loop', type: 'loop', maxIterations: 3, steps: [gate] };
  const last: Step = { id: 'last', type: 'console', run: 'last' };
  const wf: Workflow = { version: 1, name: 'W', steps: [loop, last] };

  it('hashes every block, nested ones included, in document order', () => {
    const hashes = blockHashes(wf);
    expect(Object.keys(hashes)).toEqual(['loop', 'gate', 'ok', 'fix', 'last']);
    expect(hashes.loop).toBe(blockHash(loop));
    expect(hashes.fix).toBe(blockHash(inner));
  });

  it('keeps the first of duplicate ids and skips blocks without a usable id', () => {
    const second: Step = { id: 'last', type: 'console', run: 'other' };
    const noId = lenient({ type: 'console', run: 'x' });
    const numericId = lenient({ id: 3, type: 'console', run: 'x' });
    const hashes = blockHashes({ ...wf, steps: [last, noId, numericId, second] });
    expect(hashes).toEqual({ last: blockHash(last) });
  });

  it('returns an empty record when there is no workflow or no block list', () => {
    expect(blockHashes(null)).toEqual({});
    expect(blockHashes(undefined)).toEqual({});
    expect(blockHashes({ version: 1, name: 'W' } as unknown as Workflow)).toEqual({});
    expect(blockHashes({ ...wf, steps: [null, 'x', [ok]] } as unknown as Workflow)).toEqual({});
  });
});
