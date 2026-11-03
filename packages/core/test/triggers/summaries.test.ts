import { describe, expect, it } from 'vitest';
import { triggerSummaries } from '../../src/triggers';

describe('triggerSummaries', () => {
  it('lists save, change and schedule in that order', () => {
    const on = {
      schedule: { every: '15m' },
      change: { files: ['docs/**', '!docs/gen/**'] },
      save: { files: 'src/*.ts' },
    };
    expect(triggerSummaries(on)).toEqual([
      { kind: 'save', label: 'On save: src/*.ts', files: ['src/*.ts'] },
      { kind: 'change', label: 'On change: docs/**, !docs/gen/**', files: ['docs/**', '!docs/gen/**'] },
      { kind: 'schedule', label: 'Every 15 min', every: '15m', everyMs: 900_000 },
    ]);
  });

  it('shows at most three patterns and counts the rest', () => {
    const files = ['a/**', 'b/**', 'c/**', 'd/**', 'e/**'];
    expect(triggerSummaries({ save: { files } })).toEqual([
      { kind: 'save', label: 'On save: a/**, b/**, c/** and 2 more', files },
    ]);
    expect(triggerSummaries({ save: { files: files.slice(0, 4) } })[0].label).toBe(
      'On save: a/**, b/**, c/** and 1 more',
    );
    expect(triggerSummaries({ save: { files: files.slice(0, 3) } })[0].label).toBe(
      'On save: a/**, b/**, c/**',
    );
  });

  it('drops patterns that are not text or empty and leaves out triggers without patterns', () => {
    const on = {
      save: { files: ['src/**', 3, '', '  ', null, 'lib/**'] },
      change: { files: [] },
    };
    expect(triggerSummaries(on)).toEqual([
      { kind: 'save', label: 'On save: src/**, lib/**', files: ['src/**', 'lib/**'] },
    ]);
    expect(triggerSummaries({ save: { files: '' } })).toEqual([]);
    expect(triggerSummaries({ change: { files: 12 } })).toEqual([]);
    expect(triggerSummaries({ save: {} })).toEqual([]);
    expect(triggerSummaries({ save: 'src/**' })).toEqual([]);
    expect(triggerSummaries({ change: ['docs/**'] })).toEqual([]);
  });

  it('shows a schedule it cannot read as written', () => {
    expect(triggerSummaries({ schedule: { every: '15 minutes' } })).toEqual([
      { kind: 'schedule', label: 'Every 15 minutes', every: '15 minutes' },
    ]);
    expect(triggerSummaries({ schedule: { every: 15 } })).toEqual([
      { kind: 'schedule', label: 'Every 15', every: '15' },
    ]);
    expect(triggerSummaries({ schedule: { every: '0m' } })).toEqual([
      { kind: 'schedule', label: 'Every 0m', every: '0m' },
    ]);
  });

  it('keeps schedules below the minimum (validation reports them)', () => {
    expect(triggerSummaries({ schedule: { every: '30s' } })).toEqual([
      { kind: 'schedule', label: 'Every 30 s', every: '30s', everyMs: 30_000 },
    ]);
  });

  it('leaves out schedules without a usable duration', () => {
    expect(triggerSummaries({ schedule: {} })).toEqual([]);
    expect(triggerSummaries({ schedule: { every: '' } })).toEqual([]);
    expect(triggerSummaries({ schedule: { every: ' ' } })).toEqual([]);
    expect(triggerSummaries({ schedule: { every: ['1h'] } })).toEqual([]);
    expect(triggerSummaries({ schedule: '1h' })).toEqual([]);
  });

  it('returns nothing for a missing or malformed on:', () => {
    for (const on of [undefined, null, 'save', 3, true, ['save'], {}, { push: { files: 'x' } }]) {
      expect(triggerSummaries(on)).toEqual([]);
    }
  });

  it('copies the patterns, so changing a summary leaves the workflow alone', () => {
    const files = ['src/**'];
    const [summary] = triggerSummaries({ save: { files } });
    summary.files?.push('x');
    expect(files).toEqual(['src/**']);
  });
});
