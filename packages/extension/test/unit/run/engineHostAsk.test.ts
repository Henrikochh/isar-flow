import { describe, expect, it, vi } from 'vitest';
import type { AskRequest, AskResult, StepIO } from '@isar-flow/core';
import { createEngineHost, type EngineHostDeps } from '../../../src/run/engineHost';
import { FakeTerminal } from './fakes';

function host(ask?: EngineHostDeps['ask'], secrets: Record<string, string> = {}, now = 10_000) {
  return createEngineHost({
    runId: 'run-1',
    workspaceRoot: '/ws',
    runCommand: async () => Promise.reject(new Error('unused')),
    terminal: new FakeTerminal(),
    models: { resolve: async () => Promise.reject(new Error('unused')) },
    toolHost: { execute: async () => ({ content: '' }) },
    readContextFiles: async () => [],
    approve: async () => ({ approved: true }),
    secrets,
    now: () => now,
    ...(ask && { ask }),
  });
}

const io = (): StepIO => ({
  runId: 'run-1',
  stepId: 'pick',
  signal: new AbortController().signal,
  log: () => undefined,
});

const request = (overrides: Partial<AskRequest> = {}): AskRequest => ({
  stepId: 'pick',
  question: 'Which one?',
  ...overrides,
});

describe('createEngineHost askUser', () => {
  it('has no askUser without an ask function, so the engine uses the default', () => {
    expect(host().askUser).toBeUndefined();
  });

  it('asks with the rendered question, choices, default and the expiry time', async () => {
    const ask = vi.fn(async (): Promise<AskResult> => ({ answer: 'b' }));
    const step = io();
    const result = await host(ask).askUser?.(
      request({ choices: ['a', 'b'], default: 'a', timeoutMs: 60_000 }),
      step,
    );
    expect(result).toEqual({ answer: 'b' });
    expect(ask).toHaveBeenCalledWith(
      { stepId: 'pick', question: 'Which one?', choices: ['a', 'b'], default: 'a', expiresAt: 70_000 },
      step.signal,
    );
  });

  it('leaves out what the block does not set', async () => {
    const ask = vi.fn(async (_prompt: object, _signal: AbortSignal): Promise<AskResult> => ({ answer: 'x' }));
    await host(ask).askUser?.(request(), io());
    expect(ask.mock.calls[0][0]).toEqual({ stepId: 'pick', question: 'Which one?' });
  });

  it('masks secrets in the question, choices and default and maps a masked answer back', async () => {
    const ask = vi.fn(async (prompt: Parameters<NonNullable<EngineHostDeps['ask']>>[0]) => ({
      answer: prompt.choices?.[1] ?? '',
    }));
    const engineHost = host(ask, { TOKEN: 's3cr3t-value' });
    const result = await engineHost.askUser?.(
      request({
        question: 'Use s3cr3t-value?',
        choices: ['keep', 'rotate s3cr3t-value'],
        default: 'rotate s3cr3t-value',
      }),
      io(),
    );
    const shown = ask.mock.calls[0][0];
    expect(JSON.stringify(shown)).not.toContain('s3cr3t-value');
    expect(shown.question).toContain('Use ');
    expect(result).toEqual({ answer: 'rotate s3cr3t-value' });
  });

  it('maps a masked default back for free-text questions', async () => {
    const ask = vi.fn(async (prompt: Parameters<NonNullable<EngineHostDeps['ask']>>[0]) => ({
      answer: prompt.default ?? '',
    }));
    const result = await host(ask, { TOKEN: 's3cr3t-value' }).askUser?.(
      request({ default: 'id s3cr3t-value' }),
      io(),
    );
    expect(result).toEqual({ answer: 'id s3cr3t-value' });
  });

  it('passes other answers through', async () => {
    const ask = vi.fn(async () => ({ answer: 'typed' }));
    expect(await host(ask).askUser?.(request({ default: 'x' }), io())).toEqual({ answer: 'typed' });
  });
});
