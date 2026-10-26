import { describe, expect, it } from 'vitest';
import { applyWorkflowOps, parseWorkflowText, type Workflow } from '@isar-flow/core';
import { buildCanvasModel, ROOT_LIST } from '../../../src/views/workflow/canvas/model';
import {
  canDrop,
  dropEdit,
  insertionTarget,
  moveWithinList,
  selectionAfterDelete,
} from '../../../src/views/workflow/canvas/ops';
import { REVIEW_TEXT, reviewWorkflow } from './helpers';

const model = buildCanvasModel(reviewWorkflow());
const list = (id: string, slot = 'steps') =>
  model.byId.get(id)!.children.find((c) => c.info.slot === slot)!.info;
const ids = (text: string) => parseWorkflowText(text).workflow!.steps.map((s) => s.id);

describe('canDrop', () => {
  const moveLoop = { kind: 'move', stepId: 'review_loop', stepType: 'loop', title: 'review_loop' } as const;

  it('never lets a container be dropped into itself or its children', () => {
    expect(canDrop(moveLoop, list('review_loop'), 0, model)).toBe(false);
    expect(canDrop(moveLoop, list('needs_fix', 'else'), 0, model)).toBe(false);
    expect(canDrop(moveLoop, ROOT_LIST, 0, model)).toBe(true);
  });

  it('closes the slots right before and after the dragged block', () => {
    expect(canDrop(moveLoop, ROOT_LIST, 1, model)).toBe(false);
    expect(canDrop(moveLoop, ROOT_LIST, 2, model)).toBe(false);
  });

  it('only accepts Break inside a loop', () => {
    const item = { kind: 'block', stepType: 'break' } as const;
    expect(canDrop(item, ROOT_LIST, 0, model)).toBe(false);
    expect(canDrop(item, list('needs_fix', 'then'), 0, model)).toBe(true);
  });

  it('refuses lists of containers without an id', () => {
    const broken = buildCanvasModel({
      version: 1,
      name: 'x',
      steps: [{ type: 'loop', maxIterations: 2, steps: [] }],
    } as unknown as Workflow);
    const inner = broken.entries[0].children[0].info;
    expect(canDrop({ kind: 'block', stepType: 'console' }, inner, 0, broken)).toBe(false);
  });
});

describe('dropEdit', () => {
  it('inserts a default block with the next free id and selects it', () => {
    const edit = dropEdit(
      { kind: 'block', stepType: 'console' },
      { parentId: null, slot: 'steps', index: 1 },
      reviewWorkflow(),
    );
    expect(edit.select).toBe('console_1');
    const result = applyWorkflowOps(REVIEW_TEXT, edit.ops);
    expect(result.error).toBeUndefined();
    expect(ids(result.text)).toEqual(['implement', 'console_1', 'review_loop']);
  });

  it('creates an agent block for an agent with an empty task', () => {
    const edit = dropEdit(
      { kind: 'agent', agentId: 'reviewer', name: 'Reviewer' },
      insertionTarget(model, null),
      reviewWorkflow(),
    );
    expect(edit.ops[0]).toMatchObject({
      op: 'insertStep',
      target: { parentId: null, slot: 'steps', index: 2 },
      step: { id: 'agent_1', type: 'agent', agent: 'reviewer', prompt: '' },
    });
  });

  it('moves an existing block', () => {
    const edit = dropEdit(
      { kind: 'move', stepId: 'fix', stepType: 'agent', title: 'fix' },
      { parentId: 'needs_fix', slot: 'else', index: 0 },
      reviewWorkflow(),
    );
    const workflow = parseWorkflowText(applyWorkflowOps(REVIEW_TEXT, edit.ops).text).workflow!;
    const ifStep = workflow.steps[1].type === 'loop' ? workflow.steps[1].steps[2] : null;
    expect(ifStep).toMatchObject({ then: [], else: [{ id: 'fix' }] });
  });
});

describe('insertionTarget', () => {
  it('inserts after the selection, else at the end of the workflow', () => {
    expect(insertionTarget(model, 'tests')).toEqual({ parentId: 'review_loop', slot: 'steps', index: 1 });
    expect(insertionTarget(model, null)).toEqual({ parentId: null, slot: 'steps', index: 2 });
    expect(insertionTarget(model, 'missing')).toEqual({ parentId: null, slot: 'steps', index: 2 });
  });
});

describe('moveWithinList', () => {
  const tests = model.byId.get('tests')!;
  const review = model.byId.get('review')!;

  it('produces targets that move the block exactly one place', () => {
    const down = moveWithinList(tests, 1, 3)!;
    const up = moveWithinList(review, -1, 3)!;
    const loopIds = (text: string) => {
      const loop = parseWorkflowText(text).workflow!.steps[1];
      return loop.type === 'loop' ? loop.steps.map((s) => s.id) : [];
    };
    expect(loopIds(applyWorkflowOps(REVIEW_TEXT, [down]).text)).toEqual(['review', 'tests', 'needs_fix']);
    expect(loopIds(applyWorkflowOps(REVIEW_TEXT, [up]).text)).toEqual(['review', 'tests', 'needs_fix']);
  });

  it('stops at the ends of the list', () => {
    expect(moveWithinList(tests, -1, 3)).toBeNull();
    expect(moveWithinList(model.byId.get('needs_fix')!, 1, 3)).toBeNull();
  });
});

describe('selectionAfterDelete', () => {
  it('selects the next block outside the deleted one, else the previous one', () => {
    expect(selectionAfterDelete(model, 'implement')).toBe('review_loop');
    expect(selectionAfterDelete(model, 'review_loop')).toBe('implement');
    expect(selectionAfterDelete(model, 'needs_fix')).toBe('review');
  });
});
