import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createHarness, type Harness, onChange, onSave, summary, workflowUri } from './harness';

const LINT = workflowUri('lint');
const APPROVAL = "Run 'Lint' once and choose 'Run and remember' so its triggers can start it.";
const lint = (extra = {}) => summary('lint', [onSave('src/*.ts'), onChange('docs/**')], extra);

describe('trigger service: gates', () => {
  let h: Harness;
  afterEach(() => h.dispose());

  it('lists workflows with triggers, active by default', async () => {
    h = createHarness({ workflows: [lint(), summary('build', [])] });
    await h.settle();
    expect(h.service.list()).toEqual([
      { workflowUri: LINT, name: 'Lint', state: { triggers: lint().triggers, status: 'active' } },
    ]);
    expect(h.service.state(workflowUri('build'))).toEqual({ triggers: [], status: 'active' });
  });

  it('lists workflows by name', async () => {
    h = createHarness({ workflows: [summary('zeta', [onSave('a')]), summary('alpha', [onSave('b')])] });
    expect(h.service.list().map((entry) => entry.name)).toEqual(['Alpha', 'Zeta']);
  });

  describe('setting isarFlow.triggers.enabled', () => {
    it('pauses every workflow while it is off', async () => {
      h = createHarness({ workflows: [lint()], enabled: false });
      await h.settle();
      expect(h.service.state(LINT)).toMatchObject({ status: 'paused', pausedReason: 'disabled' });
      expect(h.watchers).toHaveLength(0);
      h.save('/ws/src/a.ts');
      await h.elapse(3_000);
      expect(h.runs.start).not.toHaveBeenCalled();
    });

    it('cancels a pending start when it is turned off and resumes when it is turned on', async () => {
      h = createHarness({ workflows: [lint()] });
      await h.settle();
      h.save('/ws/src/a.ts');
      await h.elapse(1_000);
      h.changes.length = 0;
      h.setEnabled(false);
      expect(h.changes).toEqual([LINT]);
      expect(h.watchers[0].disposed).toBe(true);
      await h.elapse(5_000);
      expect(h.runs.start).not.toHaveBeenCalled();

      h.setEnabled(true);
      expect(h.service.state(LINT).status).toBe('active');
      expect(h.watchers.filter((w) => !w.disposed)).toHaveLength(1);
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start).toHaveBeenCalledTimes(1);
    });

    it('is read again when a trigger fires', async () => {
      h = createHarness({ workflows: [lint()] });
      await h.settle();
      h.save('/ws/src/a.ts');
      h.settings.enabled = false;
      await h.elapse(2_000);
      expect(h.runs.start).not.toHaveBeenCalled();
    });

    it('ignores other settings', async () => {
      h = createHarness({ workflows: [lint()] });
      await h.settle();
      h.save('/ws/src/a.ts');
      h.changeOtherSetting();
      await h.elapse(2_000);
      expect(h.runs.start).toHaveBeenCalledTimes(1);
    });

    it('reads the setting from the configuration by default', async () => {
      const get = vi.fn((_key: string, fallback?: unknown) => fallback);
      vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
        get,
      } as unknown as vscode.WorkspaceConfiguration);
      const { createTriggerService } = await import('../../../src/triggers/triggerService');
      h = createHarness();
      const service = createTriggerService({
        runs: { start: vi.fn(), active: () => [], onDidChangeRuns: () => ({ dispose: () => undefined }) },
        workflows: { list: () => [lint()], onDidChange: () => ({ dispose: () => undefined }) },
        log: { info: vi.fn() } as unknown as vscode.LogOutputChannel,
      });
      expect(service.state(LINT).status).toBe('active');
      expect(get).toHaveBeenCalledWith('triggers.enabled', true);
      get.mockReturnValue(false);
      expect(service.state(LINT).pausedReason).toBe('disabled');
      service.dispose();
      vi.restoreAllMocks();
    });
  });

  describe('workspace trust', () => {
    it('pauses in Restricted Mode and starts watching once the workspace is trusted', async () => {
      h = createHarness({ workflows: [lint()], trusted: false });
      await h.settle();
      expect(h.service.state(LINT)).toMatchObject({ status: 'paused', pausedReason: 'untrusted' });
      expect(h.watchers).toHaveLength(0);
      h.save('/ws/src/a.ts');
      await h.elapse(3_000);
      expect(h.runs.start).not.toHaveBeenCalled();

      h.grantTrust();
      expect(h.service.state(LINT).status).toBe('active');
      expect(h.watchers).toHaveLength(1);
      h.watchers[0].fire('/ws/docs/a.md');
      await h.elapse(2_000);
      expect(h.runs.start).toHaveBeenCalledTimes(1);
    });
  });

  it('pauses workflows with problems', async () => {
    h = createHarness({ workflows: [lint({ valid: false })] });
    await h.settle();
    expect(h.service.state(LINT)).toEqual({
      triggers: lint().triggers,
      status: 'paused',
      pausedReason: 'invalid',
      pausedMessage: 'The workflow has problems. Fix them to turn its triggers on.',
    });
    h.save('/ws/src/a.ts');
    await h.elapse(3_000);
    expect(h.runs.start).not.toHaveBeenCalled();
  });

  describe('command approval', () => {
    it('shows the pause as soon as the workflow appears, without a notification', async () => {
      h = createHarness({ workflows: [lint()], confirmation: 'needed' });
      await h.settle();
      expect(h.service.state(LINT)).toMatchObject({
        status: 'paused',
        pausedReason: 'approval',
        pausedMessage: APPROVAL,
      });
      expect(h.ui.showInfo).not.toHaveBeenCalled();
    });

    it('notifies once per workflow and session when a trigger fires', async () => {
      h = createHarness({ workflows: [lint()], confirmation: 'needed' });
      await h.settle();
      h.ui.showInfo.mockResolvedValueOnce('Open workflow');
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start).not.toHaveBeenCalled();
      expect(h.ui.showInfo).toHaveBeenCalledWith(APPROVAL, 'Open workflow');
      expect(h.ui.executeCommand).toHaveBeenCalledWith(
        'vscode.openWith',
        vscode.Uri.parse(LINT),
        'isarFlow.workflowEditor',
      );

      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.ui.showInfo).toHaveBeenCalledTimes(1);
    });

    it('waits for one start by hand when there is nothing to confirm', async () => {
      const firstRun = "Run 'Lint' once so its triggers can start it.";
      h = createHarness({ workflows: [lint()], confirmation: 'never-run' });
      await h.settle();
      expect(h.service.state(LINT)).toMatchObject({
        status: 'paused',
        pausedReason: 'approval',
        pausedMessage: firstRun,
      });
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start).not.toHaveBeenCalled();
      expect(h.ui.showInfo).toHaveBeenCalledWith(firstRun, 'Open workflow');

      h.runs.confirmationState.mockResolvedValue('approved');
      const runId = h.startManually(LINT);
      await h.settle();
      expect(h.service.state(LINT).status).toBe('active');
      h.finish(runId);
      await h.elapse(3_000);
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start).toHaveBeenCalledTimes(1);
    });

    it('starts once the commands were approved', async () => {
      h = createHarness({ workflows: [lint()], confirmation: 'needed' });
      await h.settle();
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      // The user runs it once and chooses "Run and remember".
      h.runs.confirmationState.mockResolvedValue('approved');
      const runId = h.startManually(LINT);
      await h.settle();
      expect(h.service.state(LINT).status).toBe('active');
      h.finish(runId);
      await h.elapse(3_000);
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start).toHaveBeenCalledTimes(1);
    });

    it('checks again after a run of the workflow finished', async () => {
      h = createHarness({ workflows: [lint()], confirmation: 'needed' });
      await h.settle();
      h.runs.confirmationState.mockResolvedValueOnce('needed');
      const runId = h.startManually(LINT);
      await h.settle();
      expect(h.service.state(LINT).status).toBe('paused');
      h.runs.confirmationState.mockResolvedValue('approved');
      h.finish(runId);
      await h.settle();
      expect(h.service.state(LINT).status).toBe('active');
    });

    it('checks again when the workflow file is saved', async () => {
      h = createHarness({ workflows: [lint()] });
      await h.settle();
      h.runs.confirmationState.mockResolvedValue('needed');
      h.save(vscode.Uri.parse(LINT).fsPath);
      await h.settle();
      expect(h.service.state(LINT).pausedReason).toBe('approval');
      expect(h.runs.start).not.toHaveBeenCalled();
    });

    it('pauses as invalid when the run manager finds problems', async () => {
      h = createHarness({ workflows: [lint()] });
      await h.settle();
      h.runs.confirmationState.mockResolvedValue('invalid');
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.service.state(LINT).pausedReason).toBe('invalid');
      expect(h.runs.start).not.toHaveBeenCalled();
      // Saving the workflow file clears it until the next trigger.
      h.runs.confirmationState.mockResolvedValue('approved');
      h.save(vscode.Uri.parse(LINT).fsPath);
      await h.settle();
      expect(h.service.state(LINT).status).toBe('active');
    });

    it('logs failed checks and keeps the state', async () => {
      h = createHarness({ workflows: [lint()] });
      await h.settle();
      h.runs.confirmationState.mockRejectedValueOnce(new Error('disk gone'));
      h.save(vscode.Uri.parse(LINT).fsPath);
      await h.settle();
      expect(h.log.warn).toHaveBeenCalledWith("Could not check the approval of 'Lint': disk gone");
      expect(h.service.state(LINT).status).toBe('active');
    });
  });

  describe('refusals', () => {
    it('pauses for missing inputs until the workflow file is saved', async () => {
      h = createHarness({ workflows: [lint()] });
      await h.settle();
      const message = "Input 'env' is required. Triggers can't ask for values: give it a default.";
      h.refuseNext({ reason: 'inputs', message });
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.service.state(LINT)).toMatchObject({
        status: 'paused',
        pausedReason: 'inputs',
        pausedMessage: message,
      });
      h.save(vscode.Uri.parse(LINT).fsPath);
      await h.settle();
      expect(h.service.state(LINT).status).toBe('active');
    });

    it('pauses for approval when the run manager refuses the confirmation', async () => {
      h = createHarness({ workflows: [lint()] });
      await h.settle();
      h.refuseNext({ reason: 'confirmation', message: APPROVAL });
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.service.state(LINT)).toMatchObject({ pausedReason: 'approval', pausedMessage: APPROVAL });
      expect(h.ui.showInfo).toHaveBeenCalledWith(APPROVAL, 'Open workflow');
    });

    it('records other refusals as skipped', async () => {
      h = createHarness({ workflows: [lint()] });
      await h.settle();
      h.refuseNext({ reason: 'running', message: 'Lint is already running.' });
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.service.state(LINT)).toMatchObject({
        status: 'active',
        lastFired: { kind: 'save', file: 'src/a.ts', skipped: 'Lint is already running.' },
      });
    });

    it('clears the inputs pause after a start', async () => {
      h = createHarness({ workflows: [lint()] });
      await h.settle();
      h.refuseNext({ reason: 'inputs', message: "Input 'env' is required." });
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.service.state(LINT).pausedReason).toBe('inputs');
      h.save('/ws/src/b.ts');
      await h.elapse(2_000);
      expect(h.service.state(LINT)).toMatchObject({ status: 'active', lastFired: { runId: 'run-1' } });
    });

    it('logs starts that throw', async () => {
      h = createHarness({ workflows: [lint()] });
      await h.settle();
      h.runs.start.mockRejectedValueOnce(new Error('boom'));
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.log.error).toHaveBeenCalledWith("The save trigger of 'Lint' failed: boom");
      h.save('/ws/src/a.ts');
      await h.elapse(2_000);
      expect(h.runs.start).toHaveBeenCalledTimes(2);
    });
  });

  it('works with a run manager without the optional finish event and confirmation state', async () => {
    h = createHarness({ workflows: [lint()], minimalRuns: true });
    await h.settle();
    h.save('/ws/src/a.ts');
    await h.elapse(2_000);
    expect(h.runs.start).toHaveBeenCalledTimes(1);
  });
});
