import { describe, expect, it } from 'vitest';
import { mergeEnv } from '../../../src/runner/env';

describe('mergeEnv', () => {
  it('adds the extra variables on top of the base', () => {
    expect(mergeEnv({ A: '1', B: '2', C: undefined }, { B: 'x', D: 'y' }, 'linux')).toEqual({
      A: '1',
      B: 'x',
      D: 'y',
    });
  });

  it('replaces variables case-insensitively on Windows', () => {
    const env = mergeEnv({ Path: 'C:\\old', Other: '1' }, { PATH: 'C:\\new' }, 'win32');
    expect(env).toEqual({ PATH: 'C:\\new', Other: '1' });
  });

  it('keeps differently cased variables apart elsewhere', () => {
    expect(mergeEnv({ Path: 'a' }, { PATH: 'b' }, 'linux')).toEqual({ Path: 'a', PATH: 'b' });
  });
});
