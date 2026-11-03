import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { IsarFlowApi } from '../../../src/extension';
import {
  activateApi,
  closeAllEditors,
  removeWorkspaceFile,
  waitFor,
  workflowUri,
  writeWorkspaceFile,
} from '../helpers';

const EXPOSED_PATH = '.isarflow/workflows/c-exposed.workflow.yaml';
const EXPOSED_FLOW = `# Created by the Copilot and run report integration test.
version: 1
name: C exposed
description: Says hello for the Copilot test
expose: true
inputs:
  who:
    type: string
    default: copilot
steps:
  - id: hello
    type: console
    run: echo hello-\${{ inputs.who }}
`;

const LIST_TOOL = 'isarflow_listWorkflows';
const RUN_TOOL = 'isarflow_runWorkflow';

const textOf = (result: vscode.LanguageModelToolResult) =>
  result.content.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : '')).join('');

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** vscode.lm.invokeTool when this VS Code has it and lists the tool. */
const canInvoke = (name: string) =>
  typeof vscode.lm?.invokeTool === 'function' && vscode.lm.tools.some((tool) => tool.name === name);

const newToken = () => new vscode.CancellationTokenSource().token;

describe('Copilot tools and run reports', () => {
  let api: IsarFlowApi;
  let exposed: vscode.Uri;
  let runId: string | undefined;

  before(async () => {
    api = await activateApi();
    await writeWorkspaceFile(EXPOSED_PATH, EXPOSED_FLOW);
    exposed = await workflowUri(api, EXPOSED_PATH);
    await waitFor(
      () => api.workflows.list().find((w) => w.relativePath === EXPOSED_PATH)?.exposed,
      'the exposed workflow in the index',
    );
  });

  after(async () => {
    await closeAllEditors();
    await removeWorkspaceFile(EXPOSED_PATH);
    await waitFor(
      () => !api.workflows.list().some((w) => w.relativePath === EXPOSED_PATH),
      'the exposed workflow to leave the index',
    );
  });

  it('registers the tools with VS Code', () => {
    const names = vscode.lm.tools.map((tool) => tool.name);
    assert.ok(names.includes(LIST_TOOL), `${LIST_TOOL} is not registered (${names.join(', ')}).`);
    assert.ok(names.includes(RUN_TOOL), `${RUN_TOOL} is not registered.`);
  });

  it('lists the exposed workflow and not the others', async () => {
    const invoked = canInvoke(LIST_TOOL);
    const result = invoked
      ? await vscode.lm.invokeTool(LIST_TOOL, { input: {}, toolInvocationToken: undefined }, newToken())
      : await api.copilot.listWorkflows.invoke({ input: {}, toolInvocationToken: undefined }, newToken());
    console.log(
      `      (${LIST_TOOL} called ${invoked ? 'with vscode.lm.invokeTool' : 'through the extension API'})`,
    );
    const text = textOf(result as vscode.LanguageModelToolResult);
    assert.match(text, /\*\*C exposed\*\*/);
    assert.ok(text.includes(EXPOSED_PATH), text);
    assert.ok(text.includes('`who` (string, default: `copilot`)'), text);
    assert.ok(!text.includes('Console basics'), text);
    assert.match(text, /other workflows? (isn't|aren't) available to Copilot/);
  });

  it('refuses to run a workflow that is not exposed', async () => {
    const runsBefore = api.runs.history.list().length;
    const input = { workflow: 'Console basics' };
    // No confirmation is prepared for workflows Copilot may not run, so invokeTool shows no dialog here.
    const invocation = canInvoke(RUN_TOOL)
      ? vscode.lm.invokeTool(RUN_TOOL, { input, toolInvocationToken: undefined }, newToken())
      : api.copilot.runWorkflow.invoke({ input, toolInvocationToken: undefined }, newToken());
    await assert.rejects(Promise.resolve(invocation), (error: unknown) => {
      assert.match(errorText(error), /isn't available to Copilot/);
      return true;
    });
    assert.equal(api.runs.history.list().length, runsBefore);
  });

  it('runs the exposed workflow as Copilot and returns its summary', async () => {
    // Outside a chat, vscode.lm.invokeTool shows the run confirmation as a modal dialog, so the tool is called
    // through the extension API here; the confirmation itself is covered by the unit tests.
    const result = await api.copilot.runWorkflow.invoke(
      { input: { workflow: 'c-exposed', inputs: { who: 'tester' } }, toolInvocationToken: undefined },
      newToken(),
    );
    const text = textOf(result as vscode.LanguageModelToolResult);
    assert.match(text, /succeeded/i);
    assert.ok(text.includes('hello-tester'), text);
    const record = api.runs.history.list(exposed.toString())[0];
    assert.ok(record, 'The Copilot run is not in the history.');
    assert.deepEqual(record.origin, { kind: 'copilot' });
    runId = record.runId;
  });

  it('exports the run report to a target file', async () => {
    assert.ok(runId, 'The Copilot run did not finish.');
    const target = vscode.Uri.file(path.join(os.tmpdir(), `isarflow-report-${process.pid}-${Date.now()}.md`));
    try {
      const text = await vscode.commands.executeCommand<string | undefined>('isarFlow.exportRunReport', {
        runId,
        target,
      });
      assert.ok(text, 'The command did not export the report.');
      const written = fs.readFileSync(target.fsPath, 'utf8');
      assert.equal(written, text);
      assert.match(written, /^# Run report: C exposed/);
      assert.ok(written.includes(EXPOSED_PATH));
    } finally {
      fs.rmSync(target.fsPath, { force: true });
    }
  });

  it('copies the pull request summary to the clipboard', async () => {
    assert.ok(runId, 'The Copilot run did not finish.');
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('isarFlow.copyRunForPr', { runId });
    const copied = await vscode.env.clipboard.readText();
    assert.match(copied, /^### C exposed: succeeded/);
  });

  it('answers @isarflow /status with the Copilot run', async () => {
    const parts: string[] = [];
    const buttons: vscode.Command[] = [];
    const stream = {
      markdown: (value: string | vscode.MarkdownString) =>
        void parts.push(typeof value === 'string' ? value : value.value),
      progress: () => undefined,
      button: (command: vscode.Command) => void buttons.push(command),
    };
    await api.copilot.chat({ command: 'status', prompt: '' }, stream, newToken());
    assert.match(parts.join(''), /\*\*C exposed\*\*: succeeded, .*Copilot/);
    assert.ok(buttons.some((button) => button.arguments?.[1] === runId));
  });
});
