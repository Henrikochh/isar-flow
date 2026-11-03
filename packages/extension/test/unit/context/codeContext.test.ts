import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { GitContext } from '@isar-flow/core';
import type { CaptureGitContext } from '@isar-flow/core/node';
import { createCodeContextCapture } from '../../../src/context/codeContext';
import { createEditorTracker } from '../../../src/context/editorTracker';
import { fakeEditor, patchWindow } from './fakes';

const ROOT = vscode.Uri.file('/ws').fsPath;
const APP = fakeEditor(vscode.Uri.file('/ws/src/app.ts'), 'let x = 1;', [{ from: [0, 4], to: [0, 5] }]);
const NOTES = fakeEditor(
  vscode.Uri.file('/ws/notes.md'),
  '# Notes',
  [{ from: [0, 2], to: [0, 7] }],
  'markdown',
);
const WORKFLOW = fakeEditor(vscode.Uri.file('/ws/.isarflow/workflows/a.workflow.yaml'), 'name: A', [
  { from: [0, 0], to: [0, 4] },
]);
const DIFF = fakeEditor(vscode.Uri.parse('git:/ws/src/app.ts'), 'let x = 0;', [{ from: [0, 0], to: [0, 3] }]);

const GIT: GitContext = { branch: 'main', changedFiles: ['src/app.ts'], diff: 'diff --git a/src/app.ts' };
const EMPTY_GIT: GitContext = { branch: '', changedFiles: [], diff: '' };

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as vscode.LogOutputChannel & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
}

describe('createEditorTracker', () => {
  let window: ReturnType<typeof patchWindow>;
  afterEach(() => window.restore());

  it('prefers the active text editor', () => {
    window = patchWindow(APP, [APP, NOTES]);
    const tracker = createEditorTracker();
    expect(tracker.current()).toBe(APP);
    tracker.dispose();
  });

  it('falls back to the most recently active editor that is still visible', () => {
    window = patchWindow(APP, [APP, NOTES]);
    const tracker = createEditorTracker();
    window.activate(NOTES);
    // A webview (the canvas) takes the focus.
    window.activate(undefined);
    expect(tracker.current()).toBe(NOTES);
    window.setVisible([APP]);
    expect(tracker.current()).toBeUndefined();
    tracker.dispose();
  });

  it('skips Isar Flow files and read-only views', () => {
    window = patchWindow(APP, [APP, WORKFLOW, DIFF]);
    const tracker = createEditorTracker();
    window.activate(WORKFLOW);
    expect(tracker.current()).toBe(APP);
    window.activate(DIFF);
    expect(tracker.current()).toBe(APP);
    tracker.dispose();
  });

  it('starts with the active editor and forgets it after dispose', () => {
    window = patchWindow(undefined, [NOTES]);
    const tracker = createEditorTracker();
    expect(tracker.current()).toBeUndefined();
    window.activate(NOTES);
    window.activate(undefined);
    tracker.dispose();
    expect(window.listeners).toHaveLength(0);
    expect(tracker.current()).toBeUndefined();
  });
});

describe('createCodeContextCapture', () => {
  let window: ReturnType<typeof patchWindow>;
  beforeEach(() => {
    window = patchWindow(APP, [APP]);
  });
  afterEach(() => {
    window.restore();
    vi.useRealTimers();
  });

  describe('editor', () => {
    it('captures the current editor relative to the root', () => {
      const capture = createCodeContextCapture({ captureGit: vi.fn() });
      expect(capture.editor(ROOT)).toEqual({
        selection: 'x',
        file: 'src/app.ts',
        language: 'typescript',
        line: 1,
      });
      capture.dispose();
    });

    it('is undefined without a text editor', () => {
      window.activate(undefined, []);
      const capture = createCodeContextCapture({ captureGit: vi.fn() });
      expect(capture.editor(ROOT)).toBeUndefined();
      capture.dispose();
    });

    it('keeps the last editor while a webview has the focus', () => {
      const capture = createCodeContextCapture({ captureGit: vi.fn() });
      window.activate(NOTES, [APP, NOTES]);
      window.activate(undefined);
      expect(capture.editor(ROOT)).toMatchObject({
        file: 'notes.md',
        selection: 'Notes',
        language: 'markdown',
      });
      capture.dispose();
    });
  });

  describe('git', () => {
    it('captures with the diff cap and the signal', async () => {
      const captureGit = vi.fn<CaptureGitContext>(async () => GIT);
      const capture = createCodeContextCapture({ captureGit, isTrusted: () => true });
      const signal = new AbortController().signal;
      expect(await capture.git(ROOT, signal)).toEqual(GIT);
      expect(captureGit).toHaveBeenCalledWith(ROOT, { signal, maxDiffBytes: 100 * 1024 });
      capture.dispose();
    });

    it('runs no git in Restricted Mode', async () => {
      const captureGit = vi.fn<CaptureGitContext>(async () => GIT);
      const capture = createCodeContextCapture({ captureGit, isTrusted: () => false });
      expect(await capture.git(ROOT)).toEqual(EMPTY_GIT);
      expect(captureGit).not.toHaveBeenCalled();
      capture.dispose();
    });

    it('reads the workspace trust by default', async () => {
      const captureGit = vi.fn<CaptureGitContext>(async () => GIT);
      const workspace = vscode.workspace as { isTrusted: boolean };
      workspace.isTrusted = false;
      try {
        const capture = createCodeContextCapture({ captureGit });
        expect(await capture.git(ROOT)).toEqual(EMPTY_GIT);
        workspace.isTrusted = true;
        expect(await capture.git(ROOT)).toEqual(GIT);
        capture.dispose();
      } finally {
        workspace.isTrusted = true;
      }
    });

    it('logs slow captures', async () => {
      vi.useFakeTimers();
      const log = fakeLog();
      const captureGit = vi.fn<CaptureGitContext>(async () => {
        vi.advanceTimersByTime(3_400);
        return GIT;
      });
      const capture = createCodeContextCapture({ captureGit, isTrusted: () => true, log });
      await capture.git(ROOT);
      expect(log.info).toHaveBeenCalledWith(`Reading the git state of ${ROOT} took 3.4 s.`);

      log.info.mockClear();
      captureGit.mockImplementation(async () => {
        vi.advanceTimersByTime(1_900);
        return GIT;
      });
      await capture.git(ROOT);
      expect(log.info).not.toHaveBeenCalled();
      capture.dispose();
    });

    it('never rejects', async () => {
      const log = fakeLog();
      const captureGit = vi.fn<CaptureGitContext>(async () => {
        throw new Error('spawn git ENOENT');
      });
      const capture = createCodeContextCapture({ captureGit, isTrusted: () => true, log });
      expect(await capture.git(ROOT)).toEqual(EMPTY_GIT);
      expect(log.warn).toHaveBeenCalledWith(`Could not read the git state of ${ROOT}: spawn git ENOENT`);
      capture.dispose();
    });
  });
});
