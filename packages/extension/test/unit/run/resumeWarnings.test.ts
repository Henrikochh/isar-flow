import { describe, expect, it } from 'vitest';
import type { ResumePreview, Workflow } from '@isar-flow/core';
import { blockLabel, resumeWarnings } from '../../../src/run/resumeWarnings';

const workflow: Workflow = {
  version: 1,
  name: 'Ship',
  steps: [
    { id: 'plan', type: 'agent', model: 'p/m', prompt: 'plan', name: 'Plan the work' },
    { id: 'build', type: 'console', run: 'build' },
    { id: 'lint', type: 'console', run: 'lint' },
    {
      id: 'rounds',
      type: 'loop',
      until: 'true',
      maxIterations: 5,
      steps: [{ id: 'tests', type: 'console', run: 'test' }],
    },
  ],
};

function preview(extra: Partial<ResumePreview> = {}): ResumePreview {
  return {
    runId: 'run-1',
    stepId: 'tests',
    reused: [],
    changed: [],
    missing: [],
    trimmed: [],
    masked: [],
    changesUnknown: false,
    loops: [],
    forcedBranches: [],
    freshSessions: [],
    ...extra,
  };
}

describe('resumeWarnings', () => {
  it('has nothing to say about a clean continuation', () => {
    expect(
      resumeWarnings(
        preview({ reused: ['plan'], loops: [{ stepId: 'rounds', iteration: 2, maxIterations: 5 }] }),
        workflow,
      ),
    ).toEqual([]);
  });

  it('names one block or several, by name when they have one', () => {
    expect(resumeWarnings(preview({ changed: ['plan'], missing: ['lint'] }), workflow)).toEqual([
      'Plan the work changed since that run, so its result may be outdated.',
      'lint has no result in that run; expressions that read it get empty values.',
    ]);
    expect(resumeWarnings(preview({ changed: ['plan', 'build', 'lint'] }), workflow)).toEqual([
      'Plan the work, build and lint changed since that run, so their results may be outdated.',
    ]);
    expect(resumeWarnings(preview({ missing: ['build', 'lint'] }), workflow)).toEqual([
      'build and lint have no result in that run; expressions that read them get empty values.',
    ]);
  });

  it('warns about unknown changes, shortened and masked results', () => {
    expect(
      resumeWarnings(preview({ changesUnknown: true, trimmed: ['build'], masked: ['plan'] }), workflow),
    ).toEqual([
      "That run was saved by an older version, so changes since then can't be checked.",
      "build's saved result was shortened to fit the history.",
      "Plan the work's result contains a secret; blocks after it get •••••• instead.",
    ]);
    expect(
      resumeWarnings(preview({ trimmed: ['build', 'lint'], masked: ['build', 'lint'] }), workflow),
    ).toEqual([
      'The saved results of build and lint were shortened to fit the history.',
      'The results of build and lint contain a secret; blocks after them get •••••• instead.',
    ]);
  });

  it('warns about loops past their limit, forced branches, new conversations and worktrees', () => {
    const warnings = resumeWarnings(
      preview({
        loops: [{ stepId: 'rounds', iteration: 7, maxIterations: 5 }],
        forcedBranches: [{ stepId: 'gate', branch: 'then' }],
        freshSessions: ['plan'],
      }),
      { ...workflow, isolation: 'worktree' },
    );
    expect(warnings).toEqual([
      'rounds was at iteration 7; its limit is now 5, so it ends after this iteration.',
      'gate took the other branch in that run; this run takes the branch with tests.',
      'Plan the work starts a new conversation.',
      'This workflow runs in a separate worktree, so files start from your workspace, not from where that run stopped.',
    ]);
    expect(resumeWarnings(preview({ freshSessions: ['plan', 'tests'] }), workflow)).toEqual([
      'Plan the work and tests start a new conversation.',
    ]);
  });

  it('labels blocks by trimmed name, else id', () => {
    expect(blockLabel(workflow, 'plan')).toBe('Plan the work');
    expect(blockLabel(workflow, 'tests')).toBe('tests');
    expect(blockLabel(workflow, 'gone')).toBe('gone');
    expect(blockLabel({ ...workflow, steps: undefined as unknown as Workflow['steps'] }, 'plan')).toBe(
      'plan',
    );
  });
});
