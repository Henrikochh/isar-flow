import { describe, expect, it } from 'vitest';
import type { RunEvent, RunReview } from '@isar-flow/core';
import { createChatHandler } from '../../../src/copilot/chatParticipant';
import { formatLocalTime } from '../../../src/report/formatTime';
import { finishedView } from '../report/fakes';
import { copilotSetup, fakeStream, fakeToken, RELEASE_URI } from './fakes';

const request = (command: string | undefined, prompt = '') => ({ command, prompt });
const hour = (n: number) => Date.UTC(2026, 10, 3, n);

async function chat(setup: ReturnType<typeof copilotSetup>, command: string | undefined, prompt = '') {
  const handler = createChatHandler(setup.services, setup.deps);
  const out = fakeStream();
  const { token, cancel } = fakeToken();
  const result = await handler(request(command, prompt), out.stream, token);
  return { ...out, result, cancel };
}

describe('@isarflow /list', () => {
  it('lists the workflows Copilot may run with buttons to open them', async () => {
    const { text, buttons } = await chat(copilotSetup(), 'list');
    expect(text()).toContain('**Release**');
    expect(text()).toContain('**Docs**');
    expect(buttons().map((b) => b.title)).toEqual(['Open Release', 'Open Docs']);
    const [open] = buttons();
    expect(open.command).toBe('vscode.openWith');
    expect(String(open.arguments?.[0])).toBe(RELEASE_URI);
    expect(open.arguments?.[1]).toBe('isarFlow.workflowEditor');
  });
});

describe('@isarflow /run', () => {
  it('runs an exposed workflow with name=value inputs and shows the summary and buttons', async () => {
    const setup = copilotSetup();
    const review = { runId: 'run-1', files: [{ path: 'a.ts' }] } as unknown as RunReview;
    setup.reviews.reviews['run-1'] = review;
    setup.behavior.during = [
      { type: 'step-start', runId: 'run-1', stepId: 'tests', stepType: 'console', at: 2 } as RunEvent,
      { type: 'step-start', runId: 'run-1', stepId: 'publish', stepType: 'console', at: 3 } as RunEvent,
    ];
    const { text, buttons, progress, result } = await chat(setup, 'run', 'release version=1.2.0 dryRun=true');
    expect(progress()).toEqual(['Running Release…', 'Running block Unit tests…', 'Running block publish…']);
    expect(text()).toBe('# chat report of run-1');
    expect(buttons()).toEqual([
      { command: 'isarFlow.internal.showRun', title: 'Open run', arguments: [RELEASE_URI, 'run-1'] },
      { command: 'isarFlow.internal.showRun', title: 'Review changes', arguments: [RELEASE_URI, 'run-1'] },
    ]);
    expect(result).toEqual({ metadata: { command: 'run', runId: 'run-1' } });
    const [, inputs, options] = setup.services.runs.start.mock.calls[0];
    expect(inputs).toEqual({ version: '1.2.0', dryRun: true });
    expect(options).toMatchObject({ origin: { kind: 'copilot' } });
  });

  it('offers no review button when nothing changed', async () => {
    const { buttons } = await chat(copilotSetup(), 'run', 'release version=1');
    expect(buttons().map((b) => b.title)).toEqual(['Open run']);
  });

  it('reports problems as errors and runs nothing', async () => {
    const setup = copilotSetup();
    const cases: [string, string][] = [
      ['', 'Name a workflow: /run <workflow> [name=value …]'],
      ['hidden', "'hidden' isn't available to Copilot. Set expose: true in its workflow file to allow it."],
      ['release', "Input 'version' is required."],
      ['release version=1 oops', "Write inputs as name=value, e.g. version=1.2.0. 'oops' has no value."],
    ];
    for (const [prompt, message] of cases) {
      const { result, text } = await chat(setup, 'run', prompt);
      expect(result.errorDetails?.message).toContain(message);
      expect(text()).toBe('');
    }
    expect(setup.services.runs.start).not.toHaveBeenCalled();
  });

  it('reports refusals of the run manager', async () => {
    const setup = copilotSetup();
    setup.behavior.refusal = { reason: 'running', message: 'Release is already running.' };
    const { result } = await chat(setup, 'run', 'release version=1');
    expect(result.errorDetails?.message).toBe('Release is already running.');
  });

  it('stops the run when the chat request is cancelled', async () => {
    const setup = copilotSetup();
    delete setup.finals['run-1'];
    const handler = createChatHandler(setup.services, setup.deps);
    const out = fakeStream();
    const { token, cancel } = fakeToken();
    const done = handler(request('run', 'release version=1'), out.stream, token);
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancel();
    expect(setup.services.runs.cancel).toHaveBeenCalledWith('run-1');
    setup.finish('run-1', finishedView('run-1', { status: 'cancelled' }));
    await done;
    expect(out.text()).toBe('# chat report of run-1');
  });
});

describe('@isarflow /status', () => {
  it('shows running runs with their block and the last runs with status, time and origin', async () => {
    const setup = copilotSetup();
    setup.state.active = [
      {
        runId: 'live',
        workflowUri: RELEASE_URI,
        view: finishedView('live', { status: 'running', activeStepId: 'tests', startedAt: hour(9) }),
      },
    ];
    setup.state.history = Array.from({ length: 7 }, (_, i) => ({
      runId: `r${i}`,
      workflowUri: RELEASE_URI,
      workflowName: i === 6 ? 'Docs' : 'Release',
      status: i === 5 ? ('failure' as const) : ('success' as const),
      startedAt: hour(i),
      ...(i === 6 && { origin: { kind: 'copilot' as const } }),
    }));
    const { text, buttons } = await chat(setup, 'status');
    const body = text();
    expect(body).toContain('**Running**');
    expect(body).toContain(`- **Release**: block Unit tests, started ${formatLocalTime(hour(9))}`);
    expect(body).toContain('**Recent runs**');
    expect(body).toContain(`- **Docs**: succeeded, ${formatLocalTime(hour(6))}, Copilot`);
    expect(body).toContain(`- **Release**: failed, ${formatLocalTime(hour(5))}`);
    expect(body).not.toContain(formatLocalTime(hour(1)));
    expect(buttons().map((b) => b.title)).toEqual([
      `Open Release (${formatLocalTime(hour(9))})`,
      `Open Docs (${formatLocalTime(hour(6))})`,
      `Open Release (${formatLocalTime(hour(5))})`,
      `Open Release (${formatLocalTime(hour(4))})`,
      `Open Release (${formatLocalTime(hour(3))})`,
      `Open Release (${formatLocalTime(hour(2))})`,
    ]);
  });

  it('says when nothing ran yet', async () => {
    const setup = copilotSetup();
    setup.state.history = [];
    const { text } = await chat(setup, 'status');
    expect(text()).toContain('Nothing is running.');
    expect(text()).toContain('No runs yet.');
  });
});

describe('@isarflow without a command', () => {
  it('explains the commands and lists the workflows Copilot may run', async () => {
    const { text, result } = await chat(copilotSetup(), undefined, 'what can you do?');
    expect(text()).toContain('`/list`');
    expect(text()).toContain('`/run <workflow> [name=value …]`');
    expect(text()).toContain('`/status`');
    expect(text()).toContain('**Release**');
    expect(result).toEqual({ metadata: { command: 'help' } });
  });
});
