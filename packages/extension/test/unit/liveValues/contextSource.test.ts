import { describe, expect, it } from 'vitest';
import { liveContext, type RunView } from '@isar-flow/core';
import { createLiveContextSource } from '../../../src/liveValues/contextSource';
import { fakeServices } from '../editors/fakes';

const view = (runId: string, status: RunView['status'] = 'success'): RunView => ({
  runId,
  workflowName: 'Review',
  status,
  startedAt: 1,
  inputs: { runId },
  usage: { inputTokens: 0, outputTokens: 0 },
  steps: {},
});

const flow = (n: number) => `file:///w/flow-${n}.workflow.yaml`;

describe('createLiveContextSource', () => {
  it('has no context for workflows without runs', async () => {
    const { services } = fakeServices();
    await expect(createLiveContextSource(services.runs)(flow(0))).resolves.toBeUndefined();
  });

  it('keeps the contexts of the most recently used runs only', async () => {
    const { services, state } = fakeServices();
    services.runs.history.list.mockImplementation((uri?: string) => {
      const n = Number(/flow-(\d+)/.exec(uri ?? '')?.[1]);
      return [
        { runId: `r${n}`, workflowUri: flow(n), workflowName: 'Review', status: 'success', startedAt: 1 },
      ];
    });
    for (let n = 0; n <= 16; n++) state.stored[`r${n}`] = view(`r${n}`);
    const contextOf = createLiveContextSource(services.runs);

    for (let n = 0; n <= 16; n++) await contextOf(flow(n));
    expect(services.runs.history.getAsync).toHaveBeenCalledTimes(17);
    // flow-1 is still cached; flow-0 was the oldest of 17 and had to go.
    await expect(contextOf(flow(1))).resolves.toEqual(liveContext(view('r1')));
    expect(services.runs.history.getAsync).toHaveBeenCalledTimes(17);
    await expect(contextOf(flow(0))).resolves.toEqual(liveContext(view('r0')));
    expect(services.runs.history.getAsync).toHaveBeenCalledTimes(18);
    // flow-1 was used recently, so flow-2 went for flow-0.
    await contextOf(flow(1));
    expect(services.runs.history.getAsync).toHaveBeenCalledTimes(18);
    await contextOf(flow(2));
    expect(services.runs.history.getAsync).toHaveBeenCalledTimes(19);
  });

  it('prefers the running run and reuses its context while its view stays the same', async () => {
    const { services, state } = fakeServices();
    const running = view('live', 'running');
    state.active = [{ runId: 'live', workflowUri: flow(1), view: running }];
    const contextOf = createLiveContextSource(services.runs);
    const first = await contextOf(flow(1));
    expect(first).toEqual(liveContext(running));
    await expect(contextOf(flow(1))).resolves.toBe(first);
    expect(services.runs.history.list).not.toHaveBeenCalled();
  });
});
