import * as vscode from 'vscode';
import { emptyGitContext } from '@isar-flow/core';
import { type CaptureGitContext, captureGitContext, GIT_DIFF_MAX_BYTES } from '@isar-flow/core/node';
import type { CodeContextCapture } from '../contracts';
import { editorContextFor, snapshotEditor } from './editorContext';
import { createEditorTracker } from './editorTracker';

/** Captures slower than this are logged, so slow repositories can be found in the log. */
const SLOW_GIT_MS = 2_000;

export interface CodeContextOptions {
  /** Default: the workspace trust. git can run repository hooks, so Restricted Mode runs none. */
  isTrusted?: () => boolean;
  captureGit?: CaptureGitContext;
  log?: vscode.LogOutputChannel;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `editor.*` from the current text editor and `git.*` from git (execFile, never a shell). */
export function createCodeContextCapture(options: CodeContextOptions = {}): CodeContextCapture {
  const isTrusted = options.isTrusted ?? (() => vscode.workspace.isTrusted);
  const captureGit = options.captureGit ?? captureGitContext;
  const tracker = createEditorTracker();

  return {
    editor(root) {
      const editor = tracker.current();
      return editor && editorContextFor(snapshotEditor(editor), root);
    },

    async git(root, signal) {
      if (!isTrusted()) return emptyGitContext();
      const started = Date.now();
      try {
        const git = await captureGit(root, { signal, maxDiffBytes: GIT_DIFF_MAX_BYTES });
        const elapsed = Date.now() - started;
        if (elapsed > SLOW_GIT_MS) {
          options.log?.info(`Reading the git state of ${root} took ${(elapsed / 1000).toFixed(1)} s.`);
        }
        return git;
      } catch (error) {
        options.log?.warn(`Could not read the git state of ${root}: ${errorText(error)}`);
        return emptyGitContext();
      }
    },

    dispose() {
      tracker.dispose();
    },
  };
}
