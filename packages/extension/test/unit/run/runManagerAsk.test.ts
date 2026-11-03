import { describe, expect, it, vi } from 'vitest';
import type { AskPrompt } from '@isar-flow/core';
import { flush } from './fakes';
import { setup } from './managerSetup';

const ASK_WORKFLOW = `version: 1
name: Deploy
steps:
  - id: target
    type: ask
    question: Deploy with \${{ secrets.TOKEN }} to?
    choices: [dev, 'prod \${{ secrets.TOKEN }}']
    default: dev
    timeout: 60
  - id: show
    type: console
    run: echo \${{ steps.target.answer }}
`;

const APPROVAL_WORKFLOW = `version: 1
name: Gate
steps:
  - id: gate
    type: approval
    message: Ship it?
`;

describe('createRunManager ask blocks', () => {
  it('asks inline with masked text and maps the masked choice back to the real one', async () => {
    const t = setup({ text: ASK_WORKFLOW, settings: { confirmCommands: false } });
    await t.secrets.set('TOKEN', 'tok-98765');
    const prompts: (AskPrompt & { workflowUri: string })[] = [];
    t.asks.onDidRequest((prompt) => prompts.push(prompt));

    const runId = (await t.manager.start(t.uri)) as string;
    for (let i = 0; i < 20 && prompts.length === 0; i++) await flush();
    expect(prompts).toHaveLength(1);
    const [prompt] = prompts;
    expect(prompt).toMatchObject({ runId, stepId: 'target', default: 'dev', workflowUri: t.uri.toString() });
    expect(JSON.stringify(prompt)).not.toContain('tok-98765');
    expect(prompt.expiresAt).toBeGreaterThan(Date.now());
    expect(t.statusItems[0].text).toBe('$(comment-discussion) Deploy: Waiting for your answer');

    t.asks.respond(prompt.requestId, prompt.choices?.[1] ?? '');
    const view = await t.manager.whenFinished(runId);
    expect(view?.status).toBe('success');
    expect(t.commands.map((c) => c.command)).toEqual(['echo prod tok-98765']);
  });

  it('asks nobody in triggered runs: the default is used, a free-text question without one fails', async () => {
    const t = setup({ text: ASK_WORKFLOW, settings: { confirmCommands: false } });
    const prompts: AskPrompt[] = [];
    t.asks.onDidRequest((prompt) => prompts.push(prompt));
    const trigger = { origin: { kind: 'trigger', trigger: 'schedule' } } as const;
    const view = await t.manager.whenFinished((await t.manager.start(t.uri, {}, trigger)) as string);
    expect(view?.status).toBe('success');
    expect(t.commands.map((c) => c.command)).toEqual(['echo dev']);

    const free = setup({
      text: 'version: 1\nname: Free\nsteps:\n  - id: why\n    type: ask\n    question: Why?\n',
      settings: { confirmCommands: false },
    });
    free.asks.onDidRequest((prompt) => prompts.push(prompt));
    const failed = await free.manager.whenFinished(
      (await free.manager.start(free.uri, {}, trigger)) as string,
    );
    expect(failed?.status).toBe('failure');
    expect(failed?.steps.why?.error).toBe("Nobody can answer 'why' here. Give it a default.");
    expect(prompts).toEqual([]);
  });

  it('withdraws the question when the run is cancelled', async () => {
    const t = setup({ text: ASK_WORKFLOW });
    const resolved: string[] = [];
    t.asks.onDidResolve(({ requestId }) => resolved.push(requestId));
    const prompts: AskPrompt[] = [];
    t.asks.onDidRequest((prompt) => prompts.push(prompt));
    const runId = (await t.manager.start(t.uri)) as string;
    for (let i = 0; i < 20 && prompts.length === 0; i++) await flush();

    t.manager.cancel(runId);
    expect((await t.manager.whenFinished(runId))?.status).toBe('cancelled');
    expect(resolved).toEqual([prompts[0].requestId]);
    expect(t.asks.pending(t.uri.toString())).toEqual([]);
  });

  it('asks with a notification when no editor is visible', async () => {
    const notices: string[] = [];
    const t = setup({
      text: ASK_WORKFLOW,
      editorVisible: false,
      settings: { confirmCommands: false },
      askUi: {
        notify: async (message) => {
          notices.push(message);
          return 'Answer';
        },
        pick: async (items) => items.find((item) => item.label === 'dev'),
      },
    });
    await t.secrets.set('TOKEN', 'tok-98765');
    const view = await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    expect(notices).toEqual(['Deploy asks: Deploy with •••••• to?']);
    expect(view?.steps.target.output).toMatchObject({ answer: 'dev', timedOut: false });
  });

  it('says the run waits for an approval in the status bar', async () => {
    const t = setup({ text: APPROVAL_WORKFLOW });
    const requests: string[] = [];
    t.approvals.onDidRequest((r) => requests.push(r.requestId));
    t.approvals.attach(t.uri.toString());
    const runId = (await t.manager.start(t.uri)) as string;
    for (let i = 0; i < 20 && requests.length === 0; i++) await flush();
    expect(t.statusItems[0].text).toBe('$(bell) Gate: Waiting for approval');
    expect(t.statusItems[0].tooltip).toBe('Gate is waiting for your approval. Click to show the workflow.');

    t.approvals.respond(requests[0], { approved: true });
    await t.manager.whenFinished(runId);
    expect(t.statusItems[0].disposed).toBe(true);
  });

  it('names the workflow in approval notifications', async () => {
    const t = setup({ text: APPROVAL_WORKFLOW, modal: true, editorVisible: false });
    const request = vi.spyOn(t.approvals, 'request');
    const view = await t.manager.whenFinished((await t.manager.start(t.uri)) as string);
    expect(view?.status).toBe('success');
    expect(request.mock.calls[0][0]).toMatchObject({
      workflowName: 'Gate',
      stepId: 'gate',
      message: 'Ship it?',
    });
  });
});
