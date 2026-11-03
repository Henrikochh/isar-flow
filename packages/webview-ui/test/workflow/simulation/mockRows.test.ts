import { describe, expect, it } from 'vitest';
import {
  defaultsText,
  mockKind,
  newRow,
  rowFromResult,
  rowProblem,
  sampleFor,
  setApproved,
  setErrorText,
  setExitCode,
  setFailing,
  setJson,
  setText,
  toResults,
} from '../../../src/views/workflow/simulation/mockRows';

const REVIEW = {
  id: 'review',
  type: 'agent',
  agent: 'reviewer',
  output: { format: 'json', schema: { approved: 'boolean', issues: 'string[]' } },
};

describe('mockKind', () => {
  it('names the editor each block type gets', () => {
    expect(mockKind({ type: 'console' })).toBe('console');
    expect(mockKind({ type: 'agent' })).toBe('text');
    expect(mockKind({ type: 'agent', output: { format: 'text' } })).toBe('text');
    expect(mockKind(REVIEW)).toBe('json');
    expect(mockKind({ type: 'approval' })).toBe('approval');
    expect(mockKind({ type: 'loop' })).toBeNull();
    expect(mockKind({ type: 'if' })).toBeNull();
    expect(mockKind({})).toBeNull();
  });
});

describe('sampleFor', () => {
  it('builds sample JSON from compact and JSON Schema shapes', () => {
    expect(sampleFor(REVIEW)).toEqual({ approved: true, issues: [] });
    expect(
      sampleFor({
        type: 'agent',
        output: {
          format: 'json',
          schema: {
            type: 'object',
            properties: { level: { type: 'string', enum: ['low', 'high'] }, score: { type: 'number' } },
          },
        },
      }),
    ).toEqual({ level: 'low', score: 0 });
    expect(sampleFor({ type: 'agent', output: { format: 'json' } })).toEqual({});
  });

  it('copes with shapes that are not valid', () => {
    expect(sampleFor({ type: 'agent', output: { format: 'json', schema: 'nonsense' } })).toEqual({});
    expect(sampleFor({ type: 'agent', output: 'json' })).toEqual({});
  });
});

describe('rows', () => {
  it('reads results into rows with their typed text', () => {
    const row = rowFromResult({ exitCode: 1, output: '1 failed' }, 3);
    expect(row).toMatchObject({ key: 3, exitCode: '1', result: { exitCode: 1, output: '1 failed' } });
    expect(rowFromResult({ json: { approved: false } }, 1).json).toBe('{\n  "approved": false\n}');
    expect(rowFromResult({ text: '{"approved": true}' }, 1).json).toBe('{"approved": true}');
    expect(rowFromResult({ error: 'Model down' }, 1).error).toBe('Model down');
  });

  it('starts new rows with the defaults of the block', () => {
    expect(newRow('console', { type: 'console' }, undefined, 1).result).toEqual({});
    expect(newRow('text', { type: 'agent' }, undefined, 1).result).toEqual({});
    const json = newRow('json', REVIEW, undefined, 1);
    expect(json.result).toEqual({ json: { approved: true, issues: [] } });
    expect(json.json).toBe('{\n  "approved": true,\n  "issues": []\n}');
    expect(newRow('approval', { type: 'approval' }, undefined, 1).result).toEqual({ approved: true });
    expect(newRow('approval', { type: 'approval' }, 'reject', 1).result).toEqual({ approved: false });
  });

  it('writes an exit code only when one is typed', () => {
    const row = rowFromResult({}, 1);
    expect(setExitCode(row, '0').result).toEqual({ exitCode: 0 });
    expect(setExitCode(setExitCode(row, '2'), '').result).toEqual({});
    const bad = setExitCode(row, '1.5');
    expect(bad.result).toEqual({});
    expect(rowProblem(bad, 'console')).toBe('Enter a whole number.');
    expect(rowProblem(setExitCode(row, ' -1 '), 'console')).toBeUndefined();
  });

  it('leaves out empty text', () => {
    const row = rowFromResult({ output: 'x', comment: 'y', text: 'z' }, 1);
    expect(setText(row, 'output', '').result).toEqual({ comment: 'y', text: 'z' });
    expect(setText(row, 'comment', 'Looks good').result).toEqual({
      output: 'x',
      comment: 'Looks good',
      text: 'z',
    });
  });

  it('parses JSON answers and reports invalid JSON', () => {
    const row = rowFromResult({ text: 'stale', json: { a: 1 } }, 1);
    const next = setJson(row, '{ "approved": true }');
    expect(next.result).toEqual({ json: { approved: true } });
    const bad = setJson(row, '{ approved }');
    expect(bad.result).toEqual({ text: 'stale', json: { a: 1 } });
    expect(rowProblem(bad, 'json')).toMatch(/^Not valid JSON: /);
    expect(setJson(row, '  ').result).toEqual({});
  });

  it('keeps an unchanged text answer of a JSON agent as it is', () => {
    const row = rowFromResult({ text: 'Here: {"approved": true}' }, 1);
    expect(rowProblem(row, 'json')).toBeUndefined();
    expect(toResults([row])).toEqual([{ text: 'Here: {"approved": true}' }]);
  });

  it('sets decisions', () => {
    const row = rowFromResult({ comment: 'ok' }, 1);
    expect(setApproved(row, false).result).toEqual({ comment: 'ok', approved: false });
  });

  it('fails a call and brings the values back when it is turned off', () => {
    const row = rowFromResult({ exitCode: 1, output: 'boom' }, 1);
    const failing = setFailing(row, true);
    expect(failing.result).toEqual({ error: 'Simulated failure' });
    expect(failing.error).toBe('Simulated failure');
    expect(setErrorText(failing, 'Disk full').result).toEqual({ error: 'Disk full' });
    // An empty message is not allowed in the file; the default stands in for it.
    expect(setErrorText(failing, ' ').result).toEqual({ error: 'Simulated failure' });
    expect(setFailing(setErrorText(failing, 'Disk full'), false).result).toEqual({
      exitCode: 1,
      output: 'boom',
    });
    // Rows read from the file keep their other values when the failure is turned off.
    expect(setFailing(rowFromResult({ exitCode: 3, error: 'x' }, 1), false).result).toEqual({ exitCode: 3 });
  });

  it('collects the results of all rows', () => {
    const rows = [rowFromResult({ exitCode: 1 }, 1), rowFromResult({}, 2)];
    expect(toResults(rows)).toEqual([{ exitCode: 1 }, {}]);
  });
});

describe('defaultsText', () => {
  it('names what Simulate uses without results', () => {
    expect(defaultsText('console')).toBe('Without results, Simulate uses exit code 0 and no output.');
    expect(defaultsText('text')).toBe('Without results, the agent answers "(simulated answer)".');
    expect(defaultsText('json')).toBe(
      'Without results, the agent answers with sample JSON built from its JSON fields.',
    );
    expect(defaultsText('approval')).toBe('Without results, the approval is approved.');
    expect(defaultsText('approval', 'reject')).toBe('Without results, the approval is rejected.');
  });
});
