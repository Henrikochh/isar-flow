import { describe, expect, it } from 'vitest';
import { LIVE_VALUE_MAX_CHARS, liveContext, liveValue } from '../../src/live';
import type { EditorContext, GitContext } from '../../src/engine/types';
import { liveCtx, runView } from './helpers';

const editor: EditorContext = {
  selection: 'const a = 1;',
  file: 'src/app.ts',
  language: 'typescript',
  line: 12,
};
const git: GitContext = { branch: 'main', changedFiles: ['a.ts', 'b.ts'], diff: '+x' };
const snapshot = {
  env: [],
  secrets: [],
  workflow: { name: 'Review loop', file: 'w.yaml' },
  workspace: { root: '/ws' },
};

describe('liveContext: editor and git', () => {
  it('copies the recorded editor and git values', () => {
    const view = runView({ context: { ...snapshot, editor, git } });
    const context = liveContext(view);
    expect(context.editor).toEqual(editor);
    expect(context.git).toEqual(git);
    expect(context.git?.changedFiles).not.toBe(git.changedFiles);
  });

  it('has none for runs that did not record them', () => {
    const context = liveContext(runView({ context: snapshot }));
    expect(context).not.toHaveProperty('editor');
    expect(context).not.toHaveProperty('git');
    expect(liveContext(runView())).not.toHaveProperty('editor');
  });
});

describe('liveValue: editor and git', () => {
  it('shows the recorded values', () => {
    const context = liveCtx({ editor, git });
    expect(liveValue(context, 'editor.file')).toEqual({
      kind: 'value',
      text: 'src/app.ts',
      type: 'text',
      truncated: false,
      masked: false,
    });
    expect(liveValue(context, 'editor.line')).toMatchObject({ text: '12', type: 'number' });
    expect(liveValue(context, 'git.changedFiles')).toMatchObject({ type: 'list' });
    expect(liveValue(context, "git.branch == 'main'")).toMatchObject({ text: 'true', type: 'boolean' });
    expect(liveValue(context, 'editor.selection')).toMatchObject({ text: 'const a = 1;' });
  });

  it('marks a selection or diff that was cut when the run was recorded', () => {
    const long = `${'d'.repeat(LIVE_VALUE_MAX_CHARS)}…`;
    const context = liveCtx({ git: { ...git, diff: long }, editor: { ...editor, selection: long } });
    expect(liveValue(context, 'git.diff')).toMatchObject({ truncated: true });
    expect(liveValue(context, 'length(editor.selection) > 0')).toMatchObject({
      text: 'true',
      truncated: true,
    });
  });

  it('shows the mask for secrets in recorded values', () => {
    const context = liveCtx({ editor: { ...editor, selection: 'token ••••••' } });
    expect(liveValue(context, 'editor.selection')).toMatchObject({ masked: true });
  });

  it('explains that older runs did not record editor or git values', () => {
    const context = liveCtx();
    expect(liveValue(context, 'editor.selection')).toEqual({
      kind: 'unavailable',
      message: "This run didn't record editor values.",
    });
    expect(liveValue(context, 'join(git.changedFiles, ", ")')).toEqual({
      kind: 'unavailable',
      message: "This run didn't record git values.",
    });
    expect(liveValue(liveCtx({ editor }), 'git.branch')).toEqual({
      kind: 'unavailable',
      message: "This run didn't record git values.",
    });
    expect(liveValue(liveCtx({ git }), 'editor.file + git.branch')).toEqual({
      kind: 'unavailable',
      message: "This run didn't record editor values.",
    });
  });
});
