import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { IsarFlowApi } from '../../../src/extension';
import { activateApi, closeAllEditors, runToEnd, waitFor, workflowUri, workspaceFolder } from '../helpers';
import { MOCK_MODEL_ID, startMockOpenAi, type MockOpenAiServer, type MockReply } from '../mockOpenAi';

// An own endpoint id, so the cached model test of other suites does not change how this model is resolved.
const PROVIDER = 'safetymock';
const MODEL = `${PROVIDER}/${MOCK_MODEL_ID}`;

const NOTES = 'notes.txt';
const CHANGE = `node -e "require('fs').writeFileSync('${NOTES}', 'changed by the run')"`;
/** A file with Windows line endings: reverts and kept worktree changes must keep them byte for byte. */
const CRLF_FILE = 'crlf.txt';
const CRLF_TEXT = 'first line\r\nsecond line\r\nthird line\r\n';
const CRLF_EDITED = 'first line\r\nsecond line, edited by the agent\r\nthird line\r\n';
const ADDED_FILE = 'added.txt';
const CONSOLE_FILE = 'console.txt';

const WORKSPACE_FLOW = `# Created by the safety net integration test.
version: 1
name: Safety net
steps:
  - id: change
    type: console
    run: ${CHANGE}
`;

const WORKTREE_FLOW = `# Created by the safety net integration test.
version: 1
name: Safety net in a worktree
isolation: worktree
setup:
  - node -e "1"
steps:
  - id: change
    type: console
    run: ${CHANGE}
`;

/** The coder agent edits through the tool host; a console block changes another file. */
const EDITS_FLOW = `# Created by the safety net integration test.
version: 1
name: Agent and console edits
steps:
  - id: edit
    type: agent
    agent: coder
    model: ${MODEL}
    prompt: Change the files.
  - id: console
    type: console
    run: node -e "require('fs').writeFileSync('${CONSOLE_FILE}', 'changed by a command')"
`;

const WORKTREE_EDITS_FLOW = `# Created by the safety net integration test.
version: 1
name: Agent edits in a worktree
isolation: worktree
steps:
  - id: edit
    type: agent
    agent: coder
    model: ${MODEL}
    prompt: Change the file.
`;

const FLOWS: Record<string, string> = {
  'safety.workflow.yaml': WORKSPACE_FLOW,
  'safety-worktree.workflow.yaml': WORKTREE_FLOW,
  'safety-edits.workflow.yaml': EDITS_FLOW,
  'safety-worktree-edits.workflow.yaml': WORKTREE_EDITS_FLOW,
};

type ToolCall = { name: string; arguments: Record<string, unknown> };

const EDIT_CRLF: ToolCall = {
  name: 'editFile',
  arguments: { path: CRLF_FILE, oldText: 'second line', newText: 'second line, edited by the agent' },
};
const WRITE_ADDED: ToolCall = {
  name: 'writeFile',
  arguments: { path: ADDED_FILE, content: 'added by the agent\n' },
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function insideRepository(folder: string): boolean {
  try {
    git(folder, 'rev-parse', '--is-inside-work-tree');
    return true;
  } catch {
    return false;
  }
}

const bytes = (file: string) => fs.readFileSync(file).toString('latin1');

describe('Safety net', function () {
  this.timeout(180_000);

  let api: IsarFlowApi;
  let root: string;
  let original: string;
  let server: MockOpenAiServer;
  /** Tool calls the mock model makes, one per turn, before it answers 'Done.'. */
  let script: ToolCall[] = [];
  /** Tool results the model received, to show why an edit failed. */
  const toolResults: string[] = [];

  const reply = (request: { messages: { role: string; content?: string | null }[] }): MockReply => {
    const results = request.messages.filter((m) => m.role === 'tool');
    const last = results.at(-1)?.content;
    if (last) toolResults.push(last);
    const next = script[results.length];
    return next ? { toolCalls: [next] } : { text: 'Done.' };
  };

  const file = (name: string) => path.join(root, name);

  before(async function () {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch {
      console.warn('git is not installed: skipping the safety net integration tests.');
      this.skip();
    }
    api = await activateApi();
    root = workspaceFolder().fsPath;
    server = await startMockOpenAi({ reply });
    await vscode.workspace
      .getConfiguration('isarFlow')
      .update(
        'providers',
        [{ id: PROVIDER, label: 'Safety mock', baseUrl: server.url }],
        vscode.ConfigurationTarget.Workspace,
      );
    await api.models.refresh();
    await waitFor(() => api.models.catalog().models.some((m) => m.ref === MODEL), `${MODEL} in the catalog`);
    // Written through VS Code, so the workflow index hears about the files without waiting for the OS watcher.
    const workflows = vscode.Uri.joinPath(workspaceFolder(), '.isarflow', 'workflows');
    for (const [name, text] of Object.entries(FLOWS)) {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(workflows, name),
        new TextEncoder().encode(text),
      );
    }
    fs.writeFileSync(file(CRLF_FILE), CRLF_TEXT);
    fs.writeFileSync(file(CONSOLE_FILE), 'written by the test\n');
    original = fs.readFileSync(file(NOTES), 'utf8');
  });

  after(async () => {
    await closeAllEditors();
    await vscode.workspace
      .getConfiguration('isarFlow')
      .update('providers', undefined, vscode.ConfigurationTarget.Workspace);
    await server?.close();
  });

  beforeEach(() => {
    script = [];
    toolResults.length = 0;
  });

  describe('without git', () => {
    before(function () {
      if (insideRepository(root)) {
        console.warn('The test workspace is inside a git repository: skipping the journal-only test.');
        this.skip();
      }
    });

    it('lists only the files agents wrote and reverts them byte for byte', async () => {
      const reviews = api.runs.reviews;
      assert.ok(reviews, 'The run manager has no review service.');
      script = [EDIT_CRLF, WRITE_ADDED];
      const uri = await workflowUri(api, '.isarflow/workflows/safety-edits.workflow.yaml');

      const { runId, view } = await runToEnd(api, uri);
      assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);
      assert.equal(bytes(file(CRLF_FILE)), CRLF_EDITED, `Tool results: ${toolResults.join(' | ')}`);
      assert.equal(fs.readFileSync(file(ADDED_FILE), 'utf8'), 'added by the agent\n');
      assert.equal(fs.readFileSync(file(CONSOLE_FILE), 'utf8'), 'changed by a command');

      const review = await reviews.get(runId);
      assert.equal(review?.coverage, 'journal');
      // The console command's change is not covered without git.
      assert.deepEqual(
        review?.files.map((f) => [f.path, f.status, f.stepIds, f.decision, f.revertible]),
        [
          [ADDED_FILE, 'added', ['edit'], 'pending', true],
          [CRLF_FILE, 'modified', ['edit'], 'pending', true],
        ],
      );

      await reviews.decide(runId, 'reverted');
      assert.equal(bytes(file(CRLF_FILE)), CRLF_TEXT);
      assert.equal(fs.existsSync(file(ADDED_FILE)), false, 'The added file was not deleted.');
      await waitFor(
        () => api.runs.history.list(uri.toString()).find((r) => r.runId === runId)?.review?.reverted === 2,
        'the review counts in the history',
      );
      fs.writeFileSync(file(CONSOLE_FILE), 'written by the test\n');
    });
  });

  describe('in a git repository', () => {
    before(() => {
      // The copied fixture workspace becomes a repository with everything committed.
      git(root, 'init', '-q');
      git(root, 'config', 'core.autocrlf', 'false');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'fixture');
    });

    it('reviews a file a console command changed, shows the diff and reverts it', async () => {
      const reviews = api.runs.reviews;
      assert.ok(reviews, 'The run manager has no review service.');
      const uri = await workflowUri(api, '.isarflow/workflows/safety.workflow.yaml');
      const indexBefore = fs.readFileSync(path.join(root, '.git', 'index'));
      const head = git(root, 'rev-parse', 'HEAD');

      const { runId, view } = await runToEnd(api, uri);
      assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);
      assert.equal(fs.readFileSync(file(NOTES), 'utf8'), 'changed by the run');

      const review = await reviews.get(runId);
      assert.ok(review, 'The run has no review.');
      assert.equal(review.coverage, 'git');
      assert.deepEqual(
        review.files.map((f) => [f.path, f.status, f.decision, f.stepIds.length]),
        [[NOTES, 'modified', 'pending', 0]],
      );
      const record = api.runs.history.list(uri.toString()).find((r) => r.runId === runId);
      assert.deepEqual(record?.review, { total: 1, kept: 0, reverted: 0, pending: 1 });
      // The snapshot left the user's repository alone.
      assert.ok(
        fs.readFileSync(path.join(root, '.git', 'index')).equals(indexBefore),
        'The git index changed.',
      );
      assert.equal(git(root, 'rev-parse', 'HEAD'), head);

      await reviews.openDiff(runId, NOTES);
      const tab = await waitFor(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputTextDiff ? input : undefined;
      }, 'the diff editor');
      assert.equal(tab.original.scheme, 'isarflow-snapshot');
      const before = await vscode.workspace.openTextDocument(tab.original);
      assert.equal(before.getText(), original);

      await reviews.decide(runId, 'reverted', [NOTES]);
      assert.equal(fs.readFileSync(file(NOTES), 'utf8'), original);
      assert.equal((await reviews.get(runId))?.files[0]?.decision, 'reverted');
      await waitFor(
        () => api.runs.history.list(uri.toString()).find((r) => r.runId === runId)?.review?.reverted === 1,
        'the review counts in the history',
      );
      assert.equal(git(root, 'status', '--porcelain', '--', NOTES), '');
    });

    it('reviews agent and console edits, reverts some byte for byte and keeps the rest', async () => {
      const reviews = api.runs.reviews;
      assert.ok(reviews, 'The run manager has no review service.');
      await closeAllEditors();
      script = [EDIT_CRLF, WRITE_ADDED];
      const uri = await workflowUri(api, '.isarflow/workflows/safety-edits.workflow.yaml');

      const { runId, view } = await runToEnd(api, uri);
      assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);
      assert.equal(bytes(file(CRLF_FILE)), CRLF_EDITED, `Tool results: ${toolResults.join(' | ')}`);
      assert.equal(view.steps.edit?.metrics?.toolCalls, 2);

      const review = await reviews.get(runId);
      assert.equal(review?.coverage, 'git');
      assert.deepEqual(
        review?.files.map((f) => [f.path, f.status, f.stepIds, f.decision]),
        [
          [ADDED_FILE, 'added', ['edit'], 'pending'],
          [CONSOLE_FILE, 'modified', [], 'pending'],
          [CRLF_FILE, 'modified', ['edit'], 'pending'],
        ],
      );

      await reviews.decide(runId, 'reverted', [CRLF_FILE, ADDED_FILE]);
      assert.equal(bytes(file(CRLF_FILE)), CRLF_TEXT);
      assert.equal(fs.existsSync(file(ADDED_FILE)), false, 'The added file was not deleted.');
      await reviews.decide(runId, 'kept', [CONSOLE_FILE]);
      assert.equal(fs.readFileSync(file(CONSOLE_FILE), 'utf8'), 'changed by a command');

      assert.deepEqual(
        (await reviews.get(runId))?.files.map((f) => [f.path, f.decision]),
        [
          [ADDED_FILE, 'reverted'],
          [CONSOLE_FILE, 'kept'],
          [CRLF_FILE, 'reverted'],
        ],
      );
      await waitFor(() => {
        const counts = api.runs.history.list(uri.toString()).find((r) => r.runId === runId)?.review;
        return counts?.pending === 0 && counts;
      }, 'the review counts in the history');
      assert.deepEqual(api.runs.history.list(uri.toString()).find((r) => r.runId === runId)?.review, {
        total: 3,
        kept: 1,
        reverted: 2,
        pending: 0,
      });
      assert.equal(git(root, 'status', '--porcelain', '--', CRLF_FILE, ADDED_FILE), '');
      git(root, 'checkout', '--', CONSOLE_FILE);
    });

    it('reverts to the unsaved text of an editor, which the agent write saved', async () => {
      const reviews = api.runs.reviews;
      assert.ok(reviews, 'The run manager has no review service.');
      await closeAllEditors();
      const document = await vscode.workspace.openTextDocument(file(CRLF_FILE));
      await vscode.window.showTextDocument(document);
      const typed = 'typed, not saved\r\n';
      try {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(0, 0), typed);
        assert.ok(await vscode.workspace.applyEdit(edit), 'VS Code refused the edit.');
        assert.ok(document.isDirty, 'The document has no unsaved changes.');
        script = [EDIT_CRLF];
        const uri = await workflowUri(api, '.isarflow/workflows/safety-edits.workflow.yaml');

        const { runId, view } = await runToEnd(api, uri);
        assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);
        assert.equal(bytes(file(CRLF_FILE)), typed + CRLF_EDITED, `Tool results: ${toolResults.join(' | ')}`);

        await reviews.decide(runId, 'reverted', [CRLF_FILE]);
        assert.equal(bytes(file(CRLF_FILE)), typed + CRLF_TEXT);
        assert.equal(document.getText(), typed + CRLF_TEXT);
        assert.equal(document.isDirty, false);
      } finally {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        git(root, 'checkout', '--', CRLF_FILE, CONSOLE_FILE);
      }
    });

    it('runs a worktree workflow on a copy and applies the kept file', async () => {
      const reviews = api.runs.reviews;
      assert.ok(reviews, 'The run manager has no review service.');
      await closeAllEditors();
      const uri = await workflowUri(api, '.isarflow/workflows/safety-worktree.workflow.yaml');

      const { runId, view } = await runToEnd(api, uri);
      assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);
      assert.equal(fs.readFileSync(file(NOTES), 'utf8'), original, 'The run changed the workspace.');

      const review = await reviews.get(runId);
      assert.equal(review?.isolation, 'worktree');
      assert.equal(review?.worktreeAvailable, true);
      assert.deepEqual(
        review?.files.map((f) => [f.path, f.status]),
        [[NOTES, 'modified']],
      );

      await reviews.decide(runId, 'kept');
      assert.equal(fs.readFileSync(file(NOTES), 'utf8'), 'changed by the run');
      assert.equal((await reviews.get(runId))?.worktreeAvailable, false);
      assert.ok(
        !git(root, 'worktree', 'list', '--porcelain').includes(runId),
        'The worktree is still registered.',
      );
    });

    it('lets an agent edit in a worktree and copies the kept change back byte for byte', async () => {
      const reviews = api.runs.reviews;
      assert.ok(reviews, 'The run manager has no review service.');
      await closeAllEditors();
      script = [EDIT_CRLF];
      const uri = await workflowUri(api, '.isarflow/workflows/safety-worktree-edits.workflow.yaml');

      const { runId, view } = await runToEnd(api, uri);
      assert.equal(view.status, 'success', `The run ended with: ${view.error ?? 'no error text'}`);
      assert.equal(bytes(file(CRLF_FILE)), CRLF_TEXT, 'The agent changed the workspace.');

      const review = await reviews.get(runId);
      assert.equal(review?.isolation, 'worktree');
      assert.deepEqual(
        review?.files.map((f) => [f.path, f.status, f.stepIds]),
        [[CRLF_FILE, 'modified', ['edit']]],
        `Tool results: ${toolResults.join(' | ')}`,
      );

      await reviews.decide(runId, 'kept');
      assert.equal(bytes(file(CRLF_FILE)), CRLF_EDITED);
      assert.equal((await reviews.get(runId))?.worktreeAvailable, false);
      git(root, 'checkout', '--', CRLF_FILE);
    });
  });
});
