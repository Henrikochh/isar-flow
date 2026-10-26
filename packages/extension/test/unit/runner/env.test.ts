import { describe, expect, it } from 'vitest';
import { commandEnv, mergeEnv } from '../../../src/runner/env';

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

describe('commandEnv', () => {
  it('drops the variables that make Electron programs start as plain Node', () => {
    const host = { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', PATH: '/bin' };
    expect(commandEnv(host, { A: '1' }, 'linux')).toEqual({ PATH: '/bin', A: '1' });
  });

  it('ignores the case of those names on Windows', () => {
    expect(commandEnv({ electron_run_as_node: '1', Path: 'C:\\bin' }, {}, 'win32')).toEqual({
      Path: 'C:\\bin',
    });
  });

  it('keeps them when the block sets them itself', () => {
    expect(commandEnv({ ELECTRON_RUN_AS_NODE: '1' }, { ELECTRON_RUN_AS_NODE: '1' }, 'linux')).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
    });
  });
});
