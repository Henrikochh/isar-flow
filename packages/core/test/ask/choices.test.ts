import { describe, expect, it } from 'vitest';
import { matchChoice } from '../../src';

describe('matchChoice', () => {
  it('returns the exact choice, else the first that differs only in case', () => {
    expect(matchChoice('prod', ['dev', 'prod'])).toBe('prod');
    expect(matchChoice('PROD', ['dev', 'Prod'])).toBe('Prod');
    expect(matchChoice('dev', ['DEV', 'dev'])).toBe('dev');
    expect(matchChoice('Dev', ['DEV', 'dev'])).toBe('DEV');
  });

  it('is undefined for answers that are none of the choices', () => {
    expect(matchChoice('staging', ['dev', 'prod'])).toBeUndefined();
    expect(matchChoice('', ['dev'])).toBeUndefined();
    expect(matchChoice('dev', [])).toBeUndefined();
  });
});
