import { describe, expect, it } from 'vitest';
import {
  EDITOR_FIELDS,
  emptyEditorContext,
  emptyGitContext,
  GIT_FIELDS,
  workflowUsesRoot,
} from '../../src/engine';
import type { Step, Workflow } from '../../src/schema/types';

const workflow = (steps: Step[], extra: Partial<Workflow> = {}): Workflow => ({
  version: 1,
  name: 'Roots',
  ...extra,
  steps,
});

const uses = (wf: Workflow | null | undefined) => ({
  editor: workflowUsesRoot(wf, 'editor'),
  git: workflowUsesRoot(wf, 'git'),
});

describe('editor and git fields', () => {
  it('lists the fields of each root', () => {
    expect(EDITOR_FIELDS).toEqual(['selection', 'file', 'language', 'line']);
    expect(GIT_FIELDS).toEqual(['branch', 'changedFiles', 'diff']);
  });

  it('builds empty contexts that are new objects every time', () => {
    expect(emptyEditorContext()).toEqual({ selection: '', file: '', language: '', line: 0 });
    expect(emptyGitContext()).toEqual({ branch: '', changedFiles: [], diff: '' });
    const first = emptyGitContext();
    first.changedFiles.push('a.ts');
    expect(emptyGitContext().changedFiles).toEqual([]);
  });
});

describe('workflowUsesRoot', () => {
  it('finds templates in every rendered block field', () => {
    const cases: Step[] = [
      { id: 'c', type: 'console', run: 'echo "${{ editor.selection }}"' },
      { id: 'c', type: 'console', run: 'npm test', cwd: '${{ editor.file }}' },
      { id: 'c', type: 'console', run: 'npm test', env: { FILE: '${{ editor.file }}' } },
      { id: 'a', type: 'agent', agent: 'coder', prompt: 'Explain ${{ editor.selection }}' },
      { id: 'a', type: 'agent', agent: 'coder', prompt: 'x', context: { files: ['${{ editor.file }}'] } },
      { id: 'ok', type: 'approval', message: 'Change ${{ editor.file }}?' },
      { id: 'end', type: 'stop', outcome: 'failure', message: 'Stopped at ${{ editor.line }}' },
      { id: 'q', type: 'ask', question: 'Fix ${{ editor.file }}?' },
      { id: 'q', type: 'ask', question: 'Which?', choices: ['a', '${{ editor.language }}'] },
      { id: 'q', type: 'ask', question: 'Which?', default: '${{ editor.language }}' },
    ];
    for (const step of cases) expect(uses(workflow([step]))).toEqual({ editor: true, git: false });
  });

  it('finds conditions written as expressions, templates and comparisons', () => {
    const conditions: Step[] = [
      { id: 'i', type: 'if', condition: "git.branch == 'main'", then: [] },
      { id: 'i', type: 'if', condition: '${{ git.diff != "" }}', then: [] },
      { id: 'i', type: 'if', condition: { value: '${{ git.branch }}', op: 'eq', to: 'main' }, then: [] },
      { id: 'i', type: 'if', condition: { value: 'main', op: 'eq', to: '${{ git.branch }}' }, then: [] },
      {
        id: 'i',
        type: 'if',
        condition: { all: [{ not: 'git.changedFiles.length > 0' }, { value: 'x', op: 'isEmpty' }] },
        then: [],
      },
      { id: 'l', type: 'loop', maxIterations: 2, until: { any: ['git.diff == ""'] }, steps: [] },
      { id: 'l', type: 'loop', maxIterations: 2, while: 'git.branch', steps: [] },
    ];
    for (const step of conditions) expect(uses(workflow([step]))).toEqual({ editor: false, git: true });
  });

  it('looks inside loops and both branches of ifs', () => {
    const nested = workflow([
      {
        id: 'outer',
        type: 'loop',
        maxIterations: 2,
        steps: [
          {
            id: 'gate',
            type: 'if',
            condition: 'true',
            then: [{ id: 'a', type: 'console', run: 'echo' }],
            else: [{ id: 'b', type: 'console', run: 'echo ${{ git.branch }}' }],
          },
        ],
      },
    ]);
    expect(uses(nested)).toEqual({ editor: false, git: true });
  });

  it('finds the roots in workflow env and input defaults', () => {
    expect(uses(workflow([], { env: { BRANCH: '${{ git.branch }}' } }))).toEqual({
      editor: false,
      git: true,
    });
    const inputs = { file: { type: 'string' as const, default: '${{ editor.file }}' } };
    expect(uses(workflow([], { inputs }))).toEqual({ editor: true, git: false });
  });

  it('reads bracket access, whole roots and references inside function calls', () => {
    expect(
      workflowUsesRoot(workflow([{ id: 'c', type: 'console', run: "${{ editor['file'] }}" }]), 'editor'),
    ).toBe(true);
    expect(workflowUsesRoot(workflow([{ id: 'c', type: 'console', run: '${{ toJSON(git) }}' }]), 'git')).toBe(
      true,
    );
    const call = workflow([{ id: 'c', type: 'console', run: "${{ contains(editor.selection, 'TODO') }}" }]);
    expect(workflowUsesRoot(call, 'editor')).toBe(true);
  });

  it('ignores other roots that only share the name and fields that are not rendered', () => {
    const steps: Step[] = [
      {
        id: 'editor',
        type: 'console',
        run: 'echo ${{ steps.editor.output }} ${{ inputs.git }}',
        name: '${{ git.branch }}',
      },
      {
        id: 'a',
        type: 'agent',
        agent: { model: 'm', systemPrompt: '${{ editor.selection }}' },
        prompt: 'Hi',
      },
      { id: 'c', type: 'console', run: 'echo editor.selection git.branch' },
    ];
    expect(uses(workflow(steps))).toEqual({ editor: false, git: false });
  });

  it('ignores expressions it cannot parse', () => {
    const steps: Step[] = [
      { id: 'a', type: 'console', run: 'echo ${{ editor. }}' },
      { id: 'b', type: 'console', run: 'echo ${{ git.branch' },
      { id: 'i', type: 'if', condition: 'git.branch ==', then: [] },
    ];
    expect(uses(workflow(steps))).toEqual({ editor: false, git: false });
  });

  it('is false for missing or malformed workflows', () => {
    expect(uses(null)).toEqual({ editor: false, git: false });
    expect(uses(undefined)).toEqual({ editor: false, git: false });
    const malformed = {
      version: 1,
      name: 'x',
      steps: 'nope',
      env: ['${{ git.branch }}'],
      inputs: 'x',
    } as unknown as Workflow;
    expect(uses(malformed)).toEqual({ editor: false, git: false });
    const odd = {
      version: 1,
      name: 'x',
      inputs: { a: null, b: { default: 3 } },
      steps: [null, 3, { id: 'c', type: 'console', run: 5, env: 'x' }, { id: 'i', type: 'if', condition: 7 }],
    } as unknown as Workflow;
    expect(uses(odd)).toEqual({ editor: false, git: false });
  });
});
