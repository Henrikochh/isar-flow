import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { MEMORY_FILE, type AskPrompt } from '@isar-flow/core';
import type { RunRefusal } from '../../../src/contracts';
import type { IsarFlowApi } from '../../../src/extension';
import {
  activateApi,
  closeAllEditors,
  runToEnd,
  stepEnd,
  waitFor,
  workflowUri,
  workspaceFolder,
} from '../helpers';
import { MOCK_MODEL_ID, startMockOpenAi, type MockChatRequest, type MockOpenAiServer } from '../mockOpenAi';

const MOCK_REF = `mock/${MOCK_MODEL_ID}`;
const ASK_PATH = '.isarflow/workflows/ask-memory-ask.workflow.yaml';
const TIMEOUT_PATH = '.isarflow/workflows/ask-memory-timeout.workflow.yaml';
const READ_PATH = '.isarflow/workflows/ask-memory-read.workflow.yaml';
const WRITE_PATH = '.isarflow/workflows/ask-memory-write.workflow.yaml';
const INPUTS_PATH = '.isarflow/workflows/ask-memory-inputs.workflow.yaml';
const MEMORY_MARKER = 'memory-marker-7731';
const NOTE = 'Tests run with npm test.';

const ASK_FLOW = `# Created by the ask and memory integration test.
version: 1
name: Ask memory ask
steps:
  - id: target
    type: ask
    question: Where should it go?
    choices: [dev, prod]
    default: dev
  - id: show
    type: console
    run: echo target-\${{ steps.target.answer }}
`;

const TIMEOUT_FLOW = `# Created by the ask and memory integration test.
version: 1
name: Ask memory timeout
steps:
  - id: target
    type: ask
    question: Nobody answers this one.
    default: staging
    timeout: 1
`;

const agentFlow = (name: string, mode: 'read' | 'write') => `# Created by the ask and memory integration test.
version: 1
name: ${name}
steps:
  - id: agent
    type: agent
    agent:
      model: ${MOCK_REF}
      memory: ${mode}
    prompt: Tell me what you know about this project.
`;

const INPUTS_FLOW = `# Created by the ask and memory integration test.
version: 1
name: Ask memory inputs
inputs:
  who:
    type: string
    required: true
steps:
  - id: greet
    type: console
    run: echo hello \${{ inputs.who }}
`;

/** Remember once when the remember tool is offered, then answer; other requests get the default script. */
function reply(request: MockChatRequest) {
  if (!request.tools?.some((tool) => tool.function?.name === 'remember'))
    return { text: 'I read the notes.' };
  const remembered = request.messages.some((message) => message.role === 'tool');
  return remembered ? { text: 'Saved.' } : { toolCalls: [{ name: 'remember', arguments: { note: NOTE } }] };
}

describe('Ask blocks and project memory', function () {
  this.timeout(120_000);

  let api: IsarFlowApi;
  let root: vscode.Uri;
  let server: MockOpenAiServer;
  /** The run in which the agent remembered a note; the report test exports it. */
  let rememberRunId: string | undefined;
  const memoryUri = () => vscode.Uri.joinPath(root, ...MEMORY_FILE.split('/'));
  const write = (relative: string, text: string) =>
    vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(root, ...relative.split('/')),
      new TextEncoder().encode(text),
    );

  before(async () => {
    api = await activateApi();
    root = workspaceFolder();
    server = await startMockOpenAi({ reply });
    await vscode.workspace
      .getConfiguration('isarFlow')
      .update(
        'providers',
        [{ id: 'mock', label: 'Mock', baseUrl: server.url }],
        vscode.ConfigurationTarget.Workspace,
      );
    await api.models.refresh();
    // Written through VS Code, so the workflow index hears about the files without waiting for the OS watcher.
    await write(ASK_PATH, ASK_FLOW);
    await write(TIMEOUT_PATH, TIMEOUT_FLOW);
    await write(READ_PATH, agentFlow('Ask memory read', 'read'));
    await write(WRITE_PATH, agentFlow('Ask memory write', 'write'));
    await write(INPUTS_PATH, INPUTS_FLOW);
  });

  after(async () => {
    await closeAllEditors();
    await vscode.workspace
      .getConfiguration('isarFlow')
      .update('providers', undefined, vscode.ConfigurationTarget.Workspace);
    await server?.close();
    for (const relative of [ASK_PATH, TIMEOUT_PATH, READ_PATH, WRITE_PATH, INPUTS_PATH, MEMORY_FILE]) {
      await vscode.workspace.fs
        .delete(vscode.Uri.joinPath(root, ...relative.split('/')), { useTrash: false })
        .then(
          () => undefined,
          () => undefined,
        );
    }
  });

  it('answers an ask block from an attached editor', async () => {
    const uri = await workflowUri(api, ASK_PATH);
    const attachment = api.runs.asks.attach(uri.toString());
    const prompts: AskPrompt[] = [];
    const subscription = api.runs.asks.onDidRequest((prompt) => {
      prompts.push(prompt);
      api.runs.asks.respond(prompt.requestId, 'prod');
    });
    try {
      const { view, events } = await runToEnd(api, uri);
      assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);
      assert.equal(prompts.length, 1);
      assert.deepEqual(
        { question: prompts[0].question, choices: prompts[0].choices, default: prompts[0].default },
        { question: 'Where should it go?', choices: ['dev', 'prod'], default: 'dev' },
      );
      const { answer, timedOut } = stepEnd(events, 'target').output;
      assert.deepEqual({ answer, timedOut }, { answer: 'prod', timedOut: false });
      assert.match(String(stepEnd(events, 'show').output.stdout), /target-prod/);
      assert.deepEqual(api.runs.asks.pending(uri.toString()), []);
    } finally {
      subscription.dispose();
      attachment.dispose();
    }
  });

  it('uses the default when nobody answers within the timeout', async () => {
    const uri = await workflowUri(api, TIMEOUT_PATH);
    const attachment = api.runs.asks.attach(uri.toString());
    const resolved: string[] = [];
    const subscription = api.runs.asks.onDidResolve(({ requestId }) => resolved.push(requestId));
    try {
      const { view, events } = await runToEnd(api, uri);
      assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);
      const target = stepEnd(events, 'target');
      assert.equal(target.output.answer, 'staging');
      assert.equal(target.output.timedOut, true);
      assert.equal(resolved.length, 1, 'The inline question was not withdrawn.');
    } finally {
      subscription.dispose();
      attachment.dispose();
    }
  });

  it('gives agents with memory read the project memory in their system prompt', async () => {
    await write(MEMORY_FILE, `# Project memory\n\n- 2026-11-01: The marker is ${MEMORY_MARKER}.\n`);
    const uri = await workflowUri(api, READ_PATH);
    const before = server.chatRequests.length;
    const { view } = await runToEnd(api, uri);
    assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);
    const [request] = server.chatRequests.slice(before);
    const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
    assert.match(system, /## Project memory/);
    assert.match(system, new RegExp(MEMORY_MARKER));
    assert.ok(
      !request.tools?.some((tool) => tool.function?.name === 'remember'),
      'read must not offer remember',
    );
  });

  it('lets agents with memory write remember a dated note that the review lists', async () => {
    await vscode.workspace.fs.delete(memoryUri(), { useTrash: false }).then(
      () => undefined,
      () => undefined,
    );
    const uri = await workflowUri(api, WRITE_PATH);
    const { runId, view } = await runToEnd(api, uri);
    assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);
    const logs = (view.steps.agent?.logs ?? []).map((line) => `${line.stream}: ${line.text}`).join('');
    assert.ok(fs.existsSync(memoryUri().fsPath), `No memory file was written. Agent log:\n${logs}`);

    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(memoryUri()));
    assert.match(text, /^# Project memory/);
    assert.match(text, new RegExp(`\\n- \\d{4}-\\d{2}-\\d{2}: ${NOTE.replace(/\./g, '\\.')}\\n$`));

    const review = await waitFor(
      async () => (await api.runs.reviews?.get(runId)) ?? false,
      'the review of the memory write run',
    );
    assert.ok(
      review.files.some((file) => file.path === MEMORY_FILE),
      `The review lists ${review.files.map((file) => file.path).join(', ') || 'no files'}.`,
    );
    rememberRunId = runId;
  });

  it('exports a run report that lists the files the run changed', async () => {
    assert.ok(rememberRunId, 'The memory write run did not finish.');
    const target = vscode.Uri.file(path.join(os.tmpdir(), `isarflow-report-${process.pid}-${Date.now()}.md`));
    try {
      const text = await vscode.commands.executeCommand<string | undefined>('isarFlow.exportRunReport', {
        runId: rememberRunId,
        target,
      });
      assert.ok(text, 'The command did not export the report.');
      const written = fs.readFileSync(target.fsPath, 'utf8');
      assert.match(written, /^# Run report: Ask memory write/);
      const changed = written.slice(written.indexOf('## Changed files'));
      assert.ok(written.includes('## Changed files'), written);
      assert.ok(changed.includes(`\`${MEMORY_FILE}\``), `The report lists no memory file:\n${changed}`);
      assert.match(changed, /\| Added \| Pending \| `agent` \|/);
    } finally {
      fs.rmSync(target.fsPath, { force: true });
    }
  });

  it('reports a trigger start with a missing required input through onRefused', async () => {
    const uri = await workflowUri(api, INPUTS_PATH);
    const refusals: RunRefusal[] = [];
    const runId = await api.runs.start(uri, undefined, {
      origin: { kind: 'trigger', trigger: 'save', file: 'notes.txt' },
      onRefused: (refusal) => refusals.push(refusal),
    });
    assert.equal(runId, undefined);
    assert.deepEqual(refusals, [
      {
        reason: 'inputs',
        message: "Input 'who' is required. Triggers can't ask for values: give it a default.",
      },
    ]);
    assert.deepEqual(api.runs.active(uri.toString()), []);
  });
});
