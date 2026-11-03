import { describe, expect, it } from 'vitest';
import type { TriggerSummary } from '@isar-flow/core';
import { OwnWrites } from '../../../src/triggers/ownWrites';
import { dueCount } from '../../../src/triggers/schedule';
import { pauseOf, triggerStateOf, type TriggerStateInput } from '../../../src/triggers/state';

const SAVE: TriggerSummary = { kind: 'save', label: 'On save: src/*.ts', files: ['src/*.ts'] };
const SCHEDULE: TriggerSummary = { kind: 'schedule', label: 'Every hour', every: '1h', everyMs: 3_600_000 };

function input(extra: Partial<TriggerStateInput> = {}): TriggerStateInput {
  return {
    name: 'Release',
    triggers: [SAVE, SCHEDULE],
    enabled: true,
    trusted: true,
    valid: true,
    invalidAtFire: false,
    limited: false,
    ...extra,
  };
}

describe('pauseOf', () => {
  it('is undefined while every gate is open', () => {
    expect(pauseOf(input())).toBeUndefined();
  });

  it('names the first closed gate', () => {
    const all = { enabled: false, trusted: false, valid: false, limited: true, approval: 'a', inputs: 'i' };
    expect(pauseOf(input(all))?.reason).toBe('disabled');
    expect(pauseOf(input({ ...all, enabled: true }))?.reason).toBe('untrusted');
    expect(pauseOf(input({ ...all, enabled: true, trusted: true }))?.reason).toBe('invalid');
    expect(pauseOf(input({ ...all, enabled: true, trusted: true, valid: true }))?.reason).toBe('limited');
    expect(pauseOf(input({ approval: 'a', inputs: 'i' }))).toEqual({ reason: 'approval', message: 'a' });
    expect(pauseOf(input({ inputs: 'i' }))).toEqual({ reason: 'inputs', message: 'i' });
    expect(pauseOf(input({ invalidAtFire: true }))?.reason).toBe('invalid');
  });

  it('explains each pause in a sentence', () => {
    expect(pauseOf(input({ enabled: false }))?.message).toBe(
      'Triggers are turned off in the settings (isarFlow.triggers.enabled).',
    );
    expect(pauseOf(input({ trusted: false }))?.message).toBe(
      'Triggers only run in trusted workspaces. Trust this workspace to turn them on.',
    );
    expect(pauseOf(input({ valid: false }))?.message).toBe(
      'The workflow has problems. Fix them to turn its triggers on.',
    );
    expect(pauseOf(input({ limited: true }))?.message).toBe(
      "'Release' started 10 times in 10 minutes, so its triggers are paused. Resume them when you're ready.",
    );
  });
});

describe('triggerStateOf', () => {
  it('is active with the next scheduled run and the last event', () => {
    const lastFired = { at: 5, kind: 'save' as const, file: 'src/a.ts', runId: 'r1' };
    expect(triggerStateOf(input({ nextRunAt: 99, lastFired }))).toEqual({
      triggers: [SAVE, SCHEDULE],
      status: 'active',
      nextRunAt: 99,
      lastFired,
    });
  });

  it('hides the next run while paused', () => {
    expect(triggerStateOf(input({ nextRunAt: 99, enabled: false }))).toEqual({
      triggers: [SAVE, SCHEDULE],
      status: 'paused',
      pausedReason: 'disabled',
      pausedMessage: 'Triggers are turned off in the settings (isarFlow.triggers.enabled).',
    });
  });
});

describe('dueCount', () => {
  it('counts the due times that passed', () => {
    expect(dueCount(1_000, 100, 999)).toBe(0);
    expect(dueCount(1_000, 100, 1_000)).toBe(1);
    expect(dueCount(1_000, 100, 1_099)).toBe(1);
    expect(dueCount(1_000, 100, 1_100)).toBe(2);
    expect(dueCount(1_000, 100, 1_350)).toBe(4);
  });
});

describe('OwnWrites', () => {
  it('drops every event until a time', () => {
    const writes = new OwnWrites();
    expect(writes.drops('a', 0)).toBe(false);
    writes.dropAll(100);
    writes.dropAll(50);
    expect(writes.drops('a', 99)).toBe(true);
    expect(writes.drops('a', 100)).toBe(false);
  });

  it('drops events of some files until a later time', () => {
    const writes = new OwnWrites();
    writes.dropFiles(['a', 'b'], 1_000, 0);
    writes.dropFiles(['b'], 500, 0);
    expect(writes.drops('a', 999)).toBe(true);
    expect(writes.drops('b', 999)).toBe(true);
    expect(writes.drops('c', 10)).toBe(false);
    expect(writes.drops('a', 1_000)).toBe(false);
    // Expired entries are forgotten.
    expect(writes.size).toBe(1);
    writes.dropFiles(['c'], 2_000, 1_000);
    expect(writes.size).toBe(1);
  });
});
