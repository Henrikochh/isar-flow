import { describe, expect, it } from 'vitest';
import type { RunOrigin } from '../../src/engine/types';
import { runOriginText } from '../../src/run';

describe('runOriginText', () => {
  it('has nothing to say about manual runs and runs without an origin', () => {
    expect(runOriginText(undefined)).toBeUndefined();
    expect(runOriginText({ kind: 'manual' })).toBeUndefined();
  });

  it.each<[RunOrigin, { chip: string; sentence: string; icon: string }]>([
    [
      { kind: 'trigger', trigger: 'save', file: 'src/app.ts' },
      { chip: 'On save', sentence: 'Started on save of src/app.ts', icon: 'save' },
    ],
    [
      { kind: 'trigger', trigger: 'save' },
      { chip: 'On save', sentence: 'Started on save', icon: 'save' },
    ],
    [
      { kind: 'trigger', trigger: 'change', file: 'docs/a.md' },
      { chip: 'On change', sentence: 'Started by a change to docs/a.md', icon: 'file' },
    ],
    [
      { kind: 'trigger', trigger: 'change' },
      { chip: 'On change', sentence: 'Started by a file change', icon: 'file' },
    ],
    [
      { kind: 'trigger', trigger: 'schedule' },
      { chip: 'Scheduled', sentence: 'Started by its schedule', icon: 'watch' },
    ],
    [{ kind: 'copilot' }, { chip: 'Copilot', sentence: 'Started by Copilot', icon: 'copilot' }],
    [{ kind: 'selection' }, { chip: 'Selection', sentence: 'Started on a selection', icon: 'selection' }],
    [{ kind: 'cli' }, { chip: 'Command line', sentence: 'Started from the command line', icon: 'terminal' }],
  ])('describes %j', (origin, text) => {
    expect(runOriginText(origin)).toEqual(text);
  });

  it('ignores an empty file and origins it does not know (history written by other versions)', () => {
    expect(runOriginText({ kind: 'trigger', trigger: 'save', file: '' })?.sentence).toBe('Started on save');
    expect(runOriginText({ kind: 'trigger', trigger: 'push' } as unknown as RunOrigin)).toBeUndefined();
    expect(runOriginText({ kind: 'webhook' } as unknown as RunOrigin)).toBeUndefined();
    expect(
      runOriginText({ kind: 'trigger', trigger: 'save', file: 3 } as unknown as RunOrigin)?.sentence,
    ).toBe('Started on save');
    expect(runOriginText('cli' as unknown as RunOrigin)).toBeUndefined();
  });
});
