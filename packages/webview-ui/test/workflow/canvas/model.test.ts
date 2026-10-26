import { describe, expect, it } from 'vitest';
import type { Workflow } from '@isar-flow/core';
import { blockTitle, buildCanvasModel } from '../../../src/views/workflow/canvas/model';
import { reviewWorkflow } from './helpers';

describe('buildCanvasModel', () => {
  it('lists blocks in document order with path keys and owning lists', () => {
    const model = buildCanvasModel(reviewWorkflow());
    expect(model.order).toEqual(['implement', 'review_loop', 'tests', 'review', 'needs_fix', 'fix']);
    const fix = model.byId.get('fix')!;
    expect(fix.key).toBe('steps/1/steps/2/then/0');
    expect(fix.list).toMatchObject({
      ownerId: 'needs_fix',
      slot: 'then',
      insideLoop: true,
      targetable: true,
    });
    expect(fix.list.chain).toEqual(['review_loop', 'needs_fix']);
    expect(model.byId.get('implement')!.list.insideLoop).toBe(false);
  });

  it('gives an If both lanes even when else is missing', () => {
    const needsFix = buildCanvasModel(reviewWorkflow()).byId.get('needs_fix')!;
    expect(needsFix.children.map((c) => [c.info.slot, c.entries.length])).toEqual([
      ['then', 1],
      ['else', 0],
    ]);
  });

  it('tolerates the lenient model: missing ids, unknown types and odd lists', () => {
    const workflow = {
      version: 1,
      name: 'Broken',
      steps: [
        { type: 'console', run: 'npm test' },
        { id: 'x', type: 'agnet', prompt: 'hi' },
        { id: 7, type: 'loop', maxIterations: 2, steps: [{ id: 'inner', type: 'break' }] },
        { id: 'odd', type: 'agent', steps: 5 },
      ],
    } as unknown as Workflow;
    const model = buildCanvasModel(workflow);
    expect(model.entries).toHaveLength(5);
    expect(model.entries[0].id).toBeUndefined();
    expect(model.entries[1].type).toBeUndefined();
    const loop = model.entries[2];
    expect(loop.id).toBeUndefined();
    expect(loop.children[0].info.targetable).toBe(false);
    expect(model.order).toEqual(['x', 'inner', 'odd']);
    expect(blockTitle(model.entries[0])).toBe('Unnamed block');
  });

  it('handles a missing workflow', () => {
    expect(buildCanvasModel(null).entries).toEqual([]);
  });
});
