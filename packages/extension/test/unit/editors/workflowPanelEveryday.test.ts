import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskPrompt, HostToWorkflowEditor, WorkflowTriggerState } from '@isar-flow/core';
import { PendingApprovals } from '../../../src/editors/approvals';
import { WorkflowPanel } from '../../../src/editors/workflowPanel';
import { FakeDocument, fakeAsks, fakeServices, fakeTriggers, fakeUi, flush } from './fakes';

const TEXT = [
  'version: 1',
  'name: Review',
  'steps:',
  '  - id: tests',
  '    type: console',
  '    run: npm test',
  '',
].join('\n');
const URI = 'file:///w/review.workflow.yaml';
const OTHER = 'file:///w/other.workflow.yaml';

const ask = (requestId: string, overrides: Partial<AskPrompt> = {}): AskPrompt => ({
  requestId,
  runId: 'r1',
  stepId: 'pick',
  question: 'Which environment?',
  choices: ['dev', 'prod'],
  default: 'dev',
  ...overrides,
});

const ACTIVE: WorkflowTriggerState = {
  triggers: [{ kind: 'save', label: 'On save: src/*.ts', files: ['src/*.ts'] }],
  status: 'active',
};

function setup(options: { asks?: boolean; triggers?: boolean } = {}) {
  const fake = fakeServices();
  const asks = fakeAsks();
  const triggers = fakeTriggers();
  if (options.asks !== false) Object.assign(fake.services.runs, { asks: asks.service });
  if (options.triggers !== false) Object.assign(fake.services, { triggers: triggers.service });
  const { ui, api } = fakeUi();
  const approvals = new PendingApprovals(fake.services.runs);
  const posted: HostToWorkflowEditor[] = [];
  const panel = new WorkflowPanel(new FakeDocument(TEXT), fake.services, api, approvals, (m) =>
    posted.push(m),
  );
  const ofType = <T extends HostToWorkflowEditor['type']>(type: T) =>
    posted.filter((m): m is Extract<HostToWorkflowEditor, { type: T }> => m.type === type);
  return { ...fake, asks, triggers, ui, panel, posted, ofType };
}

describe('WorkflowPanel asks', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('attaches to the ask broker while it is visible', () => {
    const { panel, asks } = setup();
    expect(asks.service.attach).toHaveBeenCalledTimes(1);
    expect(asks.service.attach).toHaveBeenCalledWith(URI);
    panel.setVisible(false);
    expect(asks.detach).toHaveBeenCalledTimes(1);
    panel.setVisible(true);
    expect(asks.service.attach).toHaveBeenCalledTimes(2);
    panel.dispose();
    expect(asks.detach).toHaveBeenCalledTimes(2);
  });

  it('sends the open asks of this workflow after ready, also after a webview reload', async () => {
    const { panel, asks, ofType } = setup();
    asks.pending[URI] = [ask('q1'), ask('q2', { choices: undefined, default: undefined })];
    asks.pending[OTHER] = [ask('q3')];
    await panel.handle({ type: 'ready' });
    expect(ofType('askRequest').map((m) => m.prompt.requestId)).toEqual(['q1', 'q2']);
    await panel.handle({ type: 'ready' });
    expect(ofType('askRequest').map((m) => m.prompt.requestId)).toEqual(['q1', 'q2', 'q1', 'q2']);
  });

  it('forwards new and resolved asks of this workflow only, without host fields', async () => {
    const { panel, asks, ofType, posted } = setup();
    await panel.handle({ type: 'ready' });
    posted.length = 0;
    const prompt = ask('q1', { expiresAt: 5000 });
    asks.requested.fire({ ...prompt, workflowUri: URI, ...{ workflowName: 'Review' } });
    asks.requested.fire({ ...ask('q2'), workflowUri: OTHER });
    asks.resolved.fire({ requestId: 'q1', workflowUri: URI });
    asks.resolved.fire({ requestId: 'q2', workflowUri: OTHER });
    expect(ofType('askRequest')).toEqual([{ type: 'askRequest', prompt }]);
    expect(ofType('askResolved')).toEqual([{ type: 'askResolved', requestId: 'q1' }]);
  });

  it('answers only open asks of this workflow', async () => {
    const { panel, asks } = setup();
    asks.pending[URI] = [ask('q1')];
    asks.pending[OTHER] = [ask('q2')];
    await panel.handle({ type: 'answer', requestId: 'q1', answer: 'prod' });
    await panel.handle({ type: 'answer', requestId: 'q2', answer: 'prod' });
    await panel.handle({ type: 'answer', requestId: 'gone', answer: 'prod' });
    await panel.handle({ type: 'answer', requestId: 'q1', answer: 42 as unknown as string });
    expect(asks.service.respond).toHaveBeenCalledTimes(1);
    expect(asks.service.respond).toHaveBeenCalledWith('q1', 'prod');
  });

  it('says so when an answer arrives after the question closed', async () => {
    const { panel, asks, ui } = setup();
    // The question timed out (or was answered in a notification) while the answer was on its way.
    await panel.handle({ type: 'answer', requestId: 'gone', answer: 'prod' });
    expect(ui.infos).toEqual(['This question was already answered.']);
    expect(asks.service.respond).not.toHaveBeenCalled();
  });

  it('works without an ask broker', async () => {
    const { panel, ofType } = setup({ asks: false });
    await panel.handle({ type: 'ready' });
    await panel.handle({ type: 'answer', requestId: 'q1', answer: 'dev' });
    expect(ofType('askRequest')).toEqual([]);
  });

  it('stops forwarding after dispose', () => {
    const { panel, asks, posted } = setup();
    panel.dispose();
    posted.length = 0;
    asks.requested.fire({ ...ask('q1'), workflowUri: URI });
    expect(posted).toEqual([]);
  });
});

describe('WorkflowPanel triggers', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('sends the trigger state after ready and when it changes', async () => {
    const { panel, triggers, ofType } = setup();
    triggers.states[URI] = ACTIVE;
    await panel.handle({ type: 'ready' });
    expect(ofType('triggers')).toEqual([{ type: 'triggers', triggers: ACTIVE }]);
    expect(triggers.service.state).toHaveBeenCalledWith(URI);

    const paused: WorkflowTriggerState = { ...ACTIVE, status: 'paused', pausedReason: 'limited' };
    triggers.states[URI] = paused;
    triggers.emitter.fire({ workflowUri: OTHER });
    triggers.emitter.fire({ workflowUri: URI });
    expect(ofType('triggers')).toEqual([
      { type: 'triggers', triggers: ACTIVE },
      { type: 'triggers', triggers: paused },
    ]);
  });

  it('does not push trigger changes before the webview is ready', () => {
    const { triggers, ofType } = setup();
    triggers.emitter.fire({ workflowUri: URI });
    expect(ofType('triggers')).toEqual([]);
  });

  it('resumes the triggers of this workflow', async () => {
    const { panel, triggers } = setup();
    await panel.handle({ type: 'resumeTriggers' });
    expect(triggers.service.resume).toHaveBeenCalledWith(URI);
  });

  it('works without a trigger service', async () => {
    const { panel, ofType } = setup({ triggers: false });
    await panel.handle({ type: 'ready' });
    await panel.handle({ type: 'resumeTriggers' });
    expect(ofType('triggers')).toEqual([]);
  });
});

describe('WorkflowPanel run reports and settings', () => {
  it('runs the report commands for runs of this workflow', async () => {
    const { panel, ui, state } = setup();
    state.history = [
      { runId: 'r1', workflowUri: URI, workflowName: 'Review', status: 'success', startedAt: 1 },
    ];
    await panel.handle({ type: 'runReport', runId: 'r1', action: 'export' });
    await panel.handle({ type: 'runReport', runId: 'r1', action: 'copyForPr' });
    expect(ui.commands).toEqual([
      ['isarFlow.exportRunReport', { runId: 'r1', workflowUri: URI }],
      ['isarFlow.copyRunForPr', { runId: 'r1', workflowUri: URI }],
    ]);
  });

  it('ignores reports for other runs and unknown actions', async () => {
    const { panel, ui, state } = setup();
    state.history = [
      { runId: 'r1', workflowUri: URI, workflowName: 'Review', status: 'success', startedAt: 1 },
      { runId: 'r2', workflowUri: OTHER, workflowName: 'Other', status: 'success', startedAt: 1 },
    ];
    await panel.handle({ type: 'runReport', runId: 'r2', action: 'export' });
    await panel.handle({ type: 'runReport', runId: 'r1', action: 'print' as 'export' });
    await panel.handle({ type: 'runReport', runId: 7 as unknown as string, action: 'export' });
    expect(ui.commands).toEqual([]);
  });

  it('opens the Isar Flow settings for a query', async () => {
    const { panel, ui } = setup();
    await panel.handle({ type: 'openSettings', query: ' isarFlow.triggers.enabled ' });
    await panel.handle({ type: 'openSettings', query: 'editor.fontSize' });
    await panel.handle({ type: 'openSettings', query: '' });
    await panel.handle({ type: 'openSettings', query: `isarFlow.${'x'.repeat(200)}` });
    await panel.handle({ type: 'openSettings', query: 5 as unknown as string });
    expect(ui.commands).toEqual([['workbench.action.openSettings', 'isarFlow.triggers.enabled']]);
    await flush();
  });
});
