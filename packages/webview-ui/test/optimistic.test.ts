import { describe, expect, it } from 'vitest';
import { reconcilePending } from '../src/optimistic';

describe('reconcilePending', () => {
  it('drops the edits a host document confirms, oldest first', () => {
    expect(reconcilePending(['a', 'b', 'c'], 'base', 'b')).toEqual(['c']);
    expect(reconcilePending(['a', 'b'], 'base', 'b')).toEqual([]);
  });

  it('keeps the edits while the host re-sends the text it had (e.g. after re-validating)', () => {
    expect(reconcilePending(['a', 'b'], 'base', 'base')).toEqual(['a', 'b']);
  });

  it('drops every edit when the text changed elsewhere, so the host document wins', () => {
    expect(reconcilePending(['a', 'b'], 'base', 'typed in the YAML editor')).toEqual([]);
    expect(reconcilePending([], undefined, 'anything')).toEqual([]);
  });
});
