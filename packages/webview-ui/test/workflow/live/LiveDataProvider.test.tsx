import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LiveContext } from '@isar-flow/core';
import {
  type LiveSnapshot,
  useLiveContext,
  useLiveData,
} from '../../../src/views/workflow/live/LiveDataProvider';
import { WorkflowStoreProvider } from '../../../src/views/workflow/store';
import {
  fromHost,
  lastContext,
  posted,
  renderLive,
  resetPosted,
  shownRun,
  simulation,
  storeState,
} from './helpers';

beforeEach(resetPosted);

let data: ReturnType<typeof useLiveData> | undefined;
const snapshots: (LiveSnapshot | null)[] = [];

function Probe() {
  data = useLiveData();
  const live = useLiveContext();
  snapshots.push(live);
  return (
    <div>
      <span data-testid="source">{live?.source ?? 'none'}</span>
      <span data-testid="run">{live?.context.runId ?? ''}</span>
      <span data-testid="mocks">{JSON.stringify(data.simulation?.file.blocks ?? null)}</span>
    </div>
  );
}

describe('LiveDataProvider', () => {
  beforeEach(() => {
    data = undefined;
    snapshots.length = 0;
  });

  it('keeps the simulation state and the last run context from the host', () => {
    renderLive(<Probe />);
    expect(screen.getByTestId('source')).toHaveTextContent('none');
    expect(data?.simulation).toBeNull();

    fromHost({ type: 'simulation', simulation: simulation({ blocks: { tests: [{ exitCode: 1 }] } }) });
    expect(screen.getByTestId('mocks')).toHaveTextContent('{"tests":[{"exitCode":1}]}');

    fromHost({ type: 'lastRunContext', context: lastContext() });
    expect(screen.getByTestId('source')).toHaveTextContent('last');
    expect(screen.getByTestId('run')).toHaveTextContent('run-9');

    fromHost({ type: 'lastRunContext', context: null });
    expect(screen.getByTestId('source')).toHaveTextContent('none');
  });

  it('posts mock edits and shows them at once', () => {
    renderLive(<Probe />);
    fromHost({ type: 'simulation', simulation: simulation({ blocks: { tests: [{ exitCode: 1 }] } }) });

    fromHost({ type: 'lastRunContext', context: null });
    act(() => data?.setSimulationMocks('review', [{ json: { approved: true } }]));
    expect(posted('setSimulationMocks')).toEqual([
      { type: 'setSimulationMocks', stepId: 'review', results: [{ json: { approved: true } }] },
    ]);
    expect(screen.getByTestId('mocks')).toHaveTextContent(
      '{"tests":[{"exitCode":1}],"review":[{"json":{"approved":true}}]}',
    );

    act(() => data?.setSimulationMocks('tests', null));
    expect(posted('setSimulationMocks').at(-1)).toEqual({
      type: 'setSimulationMocks',
      stepId: 'tests',
      results: null,
    });
    expect(screen.getByTestId('mocks')).toHaveTextContent('{"review":[{"json":{"approved":true}}]}');
  });

  it('opens the simulation file', () => {
    renderLive(<Probe />);
    data?.openSimulationFile();
    expect(posted()).toEqual([{ type: 'openSimulationFile' }]);
  });

  it('prefers the shown run and reuses its context while the run object stays the same', () => {
    const run = shownRun();
    renderLive(<Probe />, { run });
    fromHost({ type: 'lastRunContext', context: lastContext() });
    expect(screen.getByTestId('source')).toHaveTextContent('shown');
    expect(screen.getByTestId('run')).toHaveTextContent('run-10');
    const first = snapshots.at(-1)?.context as LiveContext;
    expect(first.steps.tests).toMatchObject({ exitCode: 0 });

    // Another render with the same run object keeps the context object.
    const renders = snapshots.length;
    fromHost({ type: 'trust', trusted: false });
    expect(snapshots.length).toBeGreaterThan(renders);
    expect(snapshots.at(-1)?.context).toBe(first);

    // The same run object in another tree (another component) gets the same context too.
    render(
      <WorkflowStoreProvider initialState={storeState({ run })}>
        <Probe />
      </WorkflowStoreProvider>,
    );
    expect(snapshots.at(-1)?.context).toBe(first);

    // A new run snapshot (e.g. the next event of a live run) gets a new context.
    fromHost({ type: 'run', run: { ...run, status: 'failure' }, live: false });
    expect(snapshots.at(-1)?.context).not.toBe(first);
    expect(snapshots.at(-1)?.context.status).toBe('failure');
  });

  it('works without a provider: nothing known, edits do nothing', () => {
    render(<Probe />);
    expect(data?.simulation).toBeNull();
    expect(data?.lastRunContext).toBeNull();
    act(() => data?.setSimulationMocks('tests', null));
    expect(posted()).toEqual([]);
  });
});
