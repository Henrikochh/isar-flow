import { describe, expect, it } from 'vitest';
import { parseWorkflowText, type ResumePreview, type RunView, type Workflow } from '@isar-flow/core';
import { blockName, resumeNotes, runFromHereState } from '../../../src/views/workflow/runFromHere/model';
import { REVIEW_TEXT } from '../canvas/helpers';

const NOW = Date.UTC(2026, 10, 3, 12, 0);
const workflow = parseWorkflowText(REVIEW_TEXT).workflow as Workflow;

function finished(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: 'run-3',
    workflowName: 'Review until approved',
    status: 'failure',
    startedAt: NOW - 5 * 60_000,
    durationMs: 60_000,
    inputs: { task: 'Add vouchers' },
    usage: { inputTokens: 0, outputTokens: 0 },
    steps: {},
    ...overrides,
  };
}

function preview(overrides: Partial<ResumePreview> = {}): ResumePreview {
  return {
    runId: 'run-3',
    stepId: 'tests',
    reused: ['implement'],
    changed: [],
    missing: [],
    trimmed: [],
    masked: [],
    changesUnknown: false,
    loops: [],
    forcedBranches: [],
    freshSessions: [],
    ...overrides,
  };
}

describe('runFromHereState', () => {
  const cases: [string, RunView | null, boolean, boolean, string | null][] = [
    ['no run', null, true, true, 'Show a finished run to run from here.'],
    ['a running run', finished({ status: 'running' }), true, true, 'Wait until the run has finished.'],
    [
      'a simulated run',
      finished({ simulated: true }),
      true,
      true,
      "Simulated runs can't be continued. Run the workflow first.",
    ],
    ['untrusted', finished(), false, true, 'Running is disabled until you trust this workspace.'],
    ['an invalid document', finished(), true, false, 'Fix the problems before running.'],
    ['a failed run', finished(), true, true, null],
    ['a succeeded run', finished({ status: 'success' }), true, true, null],
    ['a cancelled run', finished({ status: 'cancelled' }), true, true, null],
  ];
  it.each(cases)('%s', (_name, run, trusted, valid, reason) => {
    expect(runFromHereState(run, trusted, valid, 'tests')).toEqual(
      reason === null ? { ok: true } : { ok: false, reason },
    );
  });
});

describe('blockName', () => {
  it('uses the name, else the id, also for nested and unknown blocks', () => {
    const named = parseWorkflowText(
      REVIEW_TEXT.replace('      - id: tests\n', '      - id: tests\n        name: Run the tests\n'),
    ).workflow as Workflow;
    expect(blockName(named, 'tests')).toBe('Run the tests');
    expect(blockName(named, 'fix')).toBe('fix');
    expect(blockName(named, 'gone')).toBe('gone');
    expect(blockName(null, 'tests')).toBe('tests');
  });
});

describe('resumeNotes', () => {
  const notes = (p: Partial<ResumePreview>, wf: Workflow = workflow, run = finished(), reverted?: number) =>
    resumeNotes(
      preview(p),
      wf,
      run,
      reverted === undefined
        ? undefined
        : {
            runId: 'run-3',
            workflowUri: 'file:///w.yaml',
            workflowName: 'w',
            status: 'failure',
            startedAt: run.startedAt,
            review: { total: 3, kept: 3 - reverted, reverted, pending: 0 },
          },
      NOW,
    );

  it('says which run the reused results come from and where loops continue', () => {
    expect(notes({ loops: [{ stepId: 'review_loop', iteration: 3, maxIterations: 5 }] })).toEqual({
      info: [
        'Blocks before tests reuse the results of the run from 5 min ago.',
        'review_loop continues at iteration 3 of 5.',
      ],
      warnings: [],
    });
  });

  it('says nothing about reuse when nothing comes before the target', () => {
    expect(notes({ reused: [], stepId: 'implement' })).toEqual({ info: [], warnings: [] });
  });

  it('warns about changed, missing, trimmed and masked results', () => {
    expect(
      notes({
        reused: ['implement', 'review', 'fix'],
        changed: ['implement', 'review'],
        missing: ['fix'],
        trimmed: ['review'],
        masked: ['review'],
      }).warnings,
    ).toEqual([
      'implement and review changed since that run, so their results may be outdated.',
      'fix has no result in that run; expressions that read it get empty values.',
      "review's saved result was shortened to fit the history.",
      "review's result contains a secret; blocks after it get •••••• instead.",
    ]);
  });

  it('words the warnings for one and for several blocks', () => {
    expect(
      notes({
        changed: ['implement'],
        missing: ['fix', 'review', 'tests'],
        trimmed: ['implement', 'review'],
        masked: ['implement', 'review'],
        freshSessions: ['fix', 'review'],
      }).warnings,
    ).toEqual([
      'implement changed since that run, so its result may be outdated.',
      'fix, review and tests have no result in that run; expressions that read them get empty values.',
      'The saved results of implement and review were shortened to fit the history.',
      'The results of implement and review contain a secret; blocks after them get •••••• instead.',
      'fix and review start a new conversation.',
    ]);
  });

  it('warns when changes cannot be checked', () => {
    expect(notes({ changesUnknown: true }).warnings).toEqual([
      "That run was saved by an older version, so changes since then can't be checked.",
    ]);
  });

  it('warns about a loop past its limit instead of saying where it continues', () => {
    expect(notes({ loops: [{ stepId: 'review_loop', iteration: 6, maxIterations: 5 }] })).toEqual({
      info: ['Blocks before tests reuse the results of the run from 5 min ago.'],
      warnings: ['review_loop was at iteration 6; its limit is now 5, so it ends after this iteration.'],
    });
  });

  it('warns about forced branches and new conversations', () => {
    expect(
      notes({
        stepId: 'fix',
        forcedBranches: [{ stepId: 'needs_fix', branch: 'else' }],
        freshSessions: ['fix'],
      }).warnings,
    ).toEqual([
      'needs_fix took the other branch in that run; this run takes the branch with fix.',
      'fix starts a new conversation.',
    ]);
  });

  it('warns about worktree isolation and reverted files', () => {
    const isolated = { ...workflow, isolation: 'worktree' } as Workflow;
    expect(notes({}, isolated, finished(), 2).warnings).toEqual([
      'This workflow runs in a separate worktree, so files start from your workspace, not from where that run stopped.',
      'You reverted 2 files of that run; the blocks from tests on see the files as they are now.',
    ]);
    expect(notes({}, workflow, finished(), 1).warnings).toEqual([
      'You reverted 1 file of that run; the blocks from tests on see the files as they are now.',
    ]);
    expect(notes({}, workflow, finished(), 0).warnings).toEqual([]);
  });

  it('uses block names', () => {
    const named = parseWorkflowText(
      REVIEW_TEXT.replace('  - id: implement\n', '  - id: implement\n    name: Implement the task\n'),
    ).workflow as Workflow;
    expect(notes({ stepId: 'tests', changed: ['implement'] }, named)).toEqual({
      info: ['Blocks before tests reuse the results of the run from 5 min ago.'],
      warnings: ['Implement the task changed since that run, so its result may be outdated.'],
    });
  });
});
