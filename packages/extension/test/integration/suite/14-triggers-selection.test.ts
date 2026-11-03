import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as vscode from 'vscode';
import { parseWorkflowText } from '@isar-flow/core';
import type { IsarFlowApi } from '../../../src/extension';
import { CommandApprovals, consoleCommandsOf, hashCommands } from '../../../src/run/commandApproval';
import { activateApi, closeAllEditors, waitFor, workflowUri, workspaceFolder } from '../helpers';

const APPROVED_PATH = '.isarflow/workflows/c-trigger.workflow.yaml';
const UNAPPROVED_PATH = '.isarflow/workflows/c-unapproved.workflow.yaml';
const SELECTION_PATH = '.isarflow/workflows/c-selection.workflow.yaml';
const NOTES = 'notes-c.txt';
/** Written by the approved workflow itself; its change trigger matches it. */
const OUTPUT = 'out-c.txt';
const UNAPPROVED_NOTES = 'notes-u.txt';
const SOURCE = 'selection-c.txt';
const SELECTED = 'hello-selection';
/** Longer than the debounce (2 s) plus the quiet time after a run (3 s). */
const SETTLE_MS = 6_000;

const APPROVED_FLOW = `# Created by the triggers integration test.
version: 1
name: C trigger
on:
  save:
    files: ${NOTES}
  change:
    files: ${OUTPUT}
steps:
  - id: hello
    type: console
    run: node -e "require('fs').appendFileSync('${OUTPUT}', 'triggered')"
`;

const UNAPPROVED_FLOW = `# Created by the triggers integration test.
version: 1
name: C unapproved
on:
  save:
    files: ${UNAPPROVED_NOTES}
steps:
  - id: hello
    type: console
    run: echo never-approved
`;

const SELECTION_FLOW = `# Created by the selection integration test.
version: 1
name: C selection
steps:
  - id: show
    type: console
    run: 'echo \${{ editor.selection }}'
`;

const encode = (text: string) => new TextEncoder().encode(text);
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

describe('Triggers and Run workflow on selection', function () {
  this.timeout(120_000);

  let api: IsarFlowApi;
  let root: vscode.Uri;
  const uriOf = (relative: string) => vscode.Uri.joinPath(root, ...relative.split('/'));

  /** Opens a workspace file in an editor, adds a line and saves it, as a person would. */
  async function editAndSave(relative: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uriOf(relative));
    const editor = await vscode.window.showTextDocument(document);
    assert.ok(await editor.edit((edit) => edit.insert(new vscode.Position(1, 0), 'second line\n')));
    assert.ok(await document.save(), `${relative} was not saved.`);
  }

  before(async () => {
    api = await activateApi();
    root = workspaceFolder();
    // Written through VS Code, so the workflow index hears about the files without waiting for the OS watcher.
    await vscode.workspace.fs.writeFile(uriOf(APPROVED_PATH), encode(APPROVED_FLOW));
    await vscode.workspace.fs.writeFile(uriOf(UNAPPROVED_PATH), encode(UNAPPROVED_FLOW));
    await vscode.workspace.fs.writeFile(uriOf(SELECTION_PATH), encode(SELECTION_FLOW));
    await vscode.workspace.fs.writeFile(uriOf(NOTES), encode('first line\n'));
    await vscode.workspace.fs.writeFile(uriOf(OUTPUT), encode(''));
    await vscode.workspace.fs.writeFile(uriOf(UNAPPROVED_NOTES), encode('first line\n'));
    await vscode.workspace.fs.writeFile(uriOf(SOURCE), encode(`prefix ${SELECTED} suffix\n`));
  });

  after(async () => {
    await closeAllEditors();
    // Other suites count the workflows of the fixture workspace.
    const created = [APPROVED_PATH, UNAPPROVED_PATH, SELECTION_PATH];
    for (const relative of [...created, NOTES, OUTPUT, UNAPPROVED_NOTES, SOURCE]) {
      await vscode.workspace.fs.delete(uriOf(relative), { useTrash: false }).then(undefined, () => undefined);
    }
    await waitFor(
      () => !api.workflows.list().some((w) => created.includes(w.relativePath)),
      'the test workflows to leave the index',
    );
  });

  describe('save triggers', () => {
    let confirmBefore: boolean | undefined;
    const settings = () => vscode.workspace.getConfiguration('isarFlow');

    before(async () => {
      // The approved workflow's commands are remembered as with "Run and remember"; the other one never ran.
      const approved = await workflowUri(api, APPROVED_PATH);
      const workflow = parseWorkflowText(APPROVED_FLOW).workflow;
      assert.ok(workflow, 'The approved test workflow does not parse.');
      await new CommandApprovals(api.context.workspaceState).approve(
        approved.toString(),
        hashCommands(consoleCommandsOf(workflow)),
      );
      await workflowUri(api, UNAPPROVED_PATH);
      // The test profile turns confirmation off for the other suites; triggers need it on to tell the two apart.
      confirmBefore = settings().inspect<boolean>('confirmCommands')?.globalValue;
      await settings().update('confirmCommands', true, vscode.ConfigurationTarget.Global);
    });

    after(async () => {
      await settings().update('confirmCommands', confirmBefore, vscode.ConfigurationTarget.Global);
    });

    it('starts an approved workflow once on save and ignores the file it writes itself', async () => {
      const triggers = api.triggers;
      const key = (await workflowUri(api, APPROVED_PATH)).toString();
      try {
        await waitFor(
          () => triggers.state(key).triggers.length === 2 && triggers.state(key).status === 'active',
          'the save and change triggers to be active',
        );
      } catch (error) {
        throw new Error(`${String(error)} State: ${JSON.stringify(triggers.state(key))}`, { cause: error });
      }

      await editAndSave(NOTES);

      const record = await waitFor(
        () => api.runs.history.list(key).find((r) => r.origin?.kind === 'trigger'),
        'a run started by the save trigger in the history',
        30_000,
      );
      assert.deepEqual(record.origin, { kind: 'trigger', trigger: 'save', file: NOTES });
      assert.equal(record.status, 'success');
      const { lastFired } = triggers.state(key);
      assert.deepEqual([lastFired?.kind, lastFired?.file, lastFired?.runId], ['save', NOTES, record.runId]);
      assert.match(
        fs.readFileSync(uriOf(OUTPUT).fsPath, 'utf8'),
        /triggered/,
        'The run did not write its file.',
      );

      // The run changed a file its change trigger watches: that must not start it again.
      await settle();
      const started = api.runs.history.list(key).filter((r) => r.origin?.kind === 'trigger');
      assert.deepEqual(
        started.map((r) => r.runId),
        [record.runId],
        `Trigger runs: ${JSON.stringify(started.map((r) => r.origin))}`,
      );
      assert.deepEqual(api.runs.active(key), []);
      assert.equal(triggers.state(key).lastFired?.runId, record.runId);
    });

    it('does not start a workflow whose commands were never approved', async () => {
      const triggers = api.triggers;
      const key = (await workflowUri(api, UNAPPROVED_PATH)).toString();
      const runsBefore = api.runs.history.list(key).length;

      await editAndSave(UNAPPROVED_NOTES);

      await waitFor(
        () => triggers.state(key).status === 'paused' && triggers.state(key).pausedReason === 'approval',
        'the triggers to pause until the commands are approved',
      );
      assert.match(String(triggers.state(key).pausedMessage), /once and choose 'Run and remember'/);
      await settle();
      assert.equal(api.runs.history.list(key).length, runsBefore, 'The unapproved workflow ran.');
      assert.deepEqual(api.runs.active(key), []);
    });
  });

  it('runs a workflow on the selection of the active editor', async () => {
    const uri = await workflowUri(api, SELECTION_PATH);
    const document = await vscode.workspace.openTextDocument(uriOf(SOURCE));
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(
      document.positionAt('prefix '.length),
      document.positionAt(`prefix ${SELECTED}`.length),
    );

    const runId = await vscode.commands.executeCommand<string | undefined>(
      'isarFlow.runWorkflowOnSelection',
      uri,
    );
    assert.ok(runId, 'Run workflow on selection did not start a run.');
    const view = await api.runs.whenFinished(runId);
    assert.ok(view, `The run ${runId} has no final view.`);
    assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);
    assert.deepEqual(view.origin, { kind: 'selection' });
    assert.deepEqual(view.context?.editor, {
      selection: SELECTED,
      file: SOURCE,
      language: 'plaintext',
      line: 1,
    });
    // The console block got the selection through ${{ editor.selection }}.
    assert.match(String(view.steps.show?.output?.stdout ?? ''), new RegExp(SELECTED));
  });
});
