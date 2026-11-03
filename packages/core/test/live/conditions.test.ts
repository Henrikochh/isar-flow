import { describe, expect, it } from 'vitest';
import { lastConditionResult } from '../../src/live';
import { liveCtx } from './helpers';

const context = liveCtx({
  steps: {
    gate: { status: 'success', branch: 'then', result: true },
    other_gate: { status: 'success', branch: 'else', result: false },
    odd_gate: { status: 'failure', result: 'yes' },
    until_met: { status: 'success', iterations: 2, exitReason: 'condition' },
    until_max: { status: 'success', iterations: 5, exitReason: 'maxIterations' },
    while_met: { status: 'success', iterations: 1, exitReason: 'condition' },
    while_max: { status: 'success', iterations: 5, exitReason: 'maxIterations' },
    broke: { status: 'success', iterations: 1, exitReason: 'break' },
    stop_here: { status: 'success' },
  },
});

describe('lastConditionResult', () => {
  it('reads the result of if blocks', () => {
    expect(lastConditionResult({ id: 'gate', type: 'if', condition: 'x' }, context)).toBe(true);
    expect(lastConditionResult({ id: 'other_gate', type: 'if' }, context)).toBe(false);
    expect(lastConditionResult({ id: 'odd_gate', type: 'if' }, context)).toBeUndefined();
  });

  it('reads until loops: met means true, the limit means false', () => {
    expect(lastConditionResult({ id: 'until_met', type: 'loop', until: 'x' }, context)).toBe(true);
    expect(lastConditionResult({ id: 'until_max', type: 'loop', until: 'x' }, context)).toBe(false);
  });

  it('reads while loops: a met exit means false, the limit means true', () => {
    expect(lastConditionResult({ id: 'while_met', type: 'loop', while: 'x' }, context)).toBe(false);
    expect(lastConditionResult({ id: 'while_max', type: 'loop', while: 'x' }, context)).toBe(true);
  });

  it('is undefined for breaks, loops without a condition and blocks without a result', () => {
    expect(lastConditionResult({ id: 'broke', type: 'loop', until: 'x' }, context)).toBeUndefined();
    expect(lastConditionResult({ id: 'until_met', type: 'loop' }, context)).toBeUndefined();
    expect(
      lastConditionResult({ id: 'until_met', type: 'loop', until: 'x', while: 'y' }, context),
    ).toBeUndefined();
    expect(lastConditionResult({ id: 'missing', type: 'if' }, context)).toBeUndefined();
    expect(lastConditionResult({ id: 'missing', type: 'loop', until: 'x' }, context)).toBeUndefined();
    expect(lastConditionResult({ id: 'stop_here', type: 'stop' }, context)).toBeUndefined();
    expect(lastConditionResult({ id: 'gate', type: 'console' }, context)).toBeUndefined();
  });

  it('accepts lenient records', () => {
    expect(lastConditionResult(null, context)).toBeUndefined();
    expect(lastConditionResult('gate', context)).toBeUndefined();
    expect(lastConditionResult({ type: 'if' }, context)).toBeUndefined();
    expect(lastConditionResult({ id: 3, type: 'if' }, context)).toBeUndefined();
    expect(lastConditionResult([], context)).toBeUndefined();
  });
});
