import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyWorkflowOps, type WorkflowOp } from '@isar-flow/core';
import {
  card,
  clearPosted,
  docFor,
  host,
  posted,
  postedOps,
  renderEditor,
  REVIEW_TEXT,
  stubLayout,
} from './helpers';

vi.mock('../../../src/views/workflow/inspector/Inspector', () => ({
  Inspector: () => (
    <aside aria-label="Inspector">
      <input aria-label="Inspector field" />
    </aside>
  ),
}));

beforeAll(stubLayout);
afterEach(cleanup);

describe('workflow editor shell', () => {
  it('posts ready once on mount', () => {
    renderEditor();
    expect(posted().filter((m) => m.type === 'ready')).toHaveLength(1);
  });

  it('renders the river with the real block content', () => {
    const { container } = renderEditor();
    expect(screen.getByText('Start')).toBeInTheDocument();
    expect(screen.getByText('End')).toBeInTheDocument();
    expect(card(container, 'implement')).toHaveTextContent('Coder');
    expect(card(container, 'implement')).toHaveTextContent('inputs.task');
    expect(card(container, 'tests')).toHaveTextContent('npm test');
    expect(card(container, 'tests')).toHaveTextContent('Continues on error');
    expect(card(container, 'review')).toHaveTextContent('JSON answer');
    expect(screen.getByText(/Repeat until/)).toBeInTheDocument();
    expect(screen.getByText('tests.exitCode = 0 and review.json.approved is true')).toBeInTheDocument();
    expect(screen.getByText('Then')).toBeInTheDocument();
    expect(screen.getByText('Drop a block here')).toBeInTheDocument();
  });

  it('shows a warning badge instead of crashing on blocks without ids or with unknown types', () => {
    const text =
      'version: 1\nname: Broken\nsteps:\n  - type: console\n    run: ls\n  - id: odd\n    type: agnet\n';
    const { container } = renderEditor(docFor(text));
    expect(screen.getByText('No id')).toBeInTheDocument();
    expect(card(container, 'odd')).toHaveTextContent('“agnet” is not a block type');
  });

  it('shows the empty state and adds a first block', () => {
    renderEditor(docFor('version: 1\nname: Empty\nsteps: []\n'));
    expect(screen.getByText('Add your first block')).toBeInTheDocument();
    clearPosted();
    fireEvent.click(screen.getByRole('button', { name: 'Add console command' }));
    expect(postedOps()).toEqual([
      expect.objectContaining({
        op: 'insertStep',
        target: { parentId: null, slot: 'steps', index: 0 },
        step: expect.objectContaining({ id: 'console_1', type: 'console' }),
      }),
    ]);
  });
});

describe('selection and keyboard', () => {
  it('selects a card on click and clears on Escape', () => {
    const { container } = renderEditor();
    fireEvent.click(card(container, 'tests'));
    expect(card(container, 'tests')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(card(container, 'tests'), { key: 'Escape' });
    expect(card(container, 'tests')).toHaveAttribute('aria-pressed', 'false');
  });

  it('moves the selection in document order with the arrow keys', () => {
    const { container } = renderEditor();
    fireEvent.click(card(container, 'implement'));
    fireEvent.keyDown(card(container, 'implement'), { key: 'ArrowDown' });
    expect(card(container, 'review_loop')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(card(container, 'review_loop'), { key: 'ArrowDown' });
    expect(card(container, 'tests')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(card(container, 'tests'), { key: 'ArrowUp' });
    expect(card(container, 'review_loop')).toHaveAttribute('aria-pressed', 'true');
  });

  it('deletes, duplicates and moves the selected block', () => {
    const { container } = renderEditor();
    fireEvent.click(card(container, 'tests'));
    clearPosted();
    fireEvent.keyDown(card(container, 'tests'), { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(card(container, 'tests'), { key: 'd', ctrlKey: true });
    fireEvent.keyDown(card(container, 'tests'), { key: 'Delete' });
    expect(postedOps()).toEqual([
      { op: 'moveStep', stepId: 'tests', target: { parentId: 'review_loop', slot: 'steps', index: 2 } },
      { op: 'duplicateStep', stepId: 'tests' },
      { op: 'deleteStep', stepId: 'tests' },
    ]);
    expect(card(container, 'review')).toHaveAttribute('aria-pressed', 'true');
  });

  it('focuses the inspector on Enter', () => {
    const { container } = renderEditor();
    fireEvent.click(card(container, 'tests'));
    fireEvent.keyDown(card(container, 'tests'), { key: 'Enter' });
    expect(screen.getByLabelText('Inspector field')).toHaveFocus();
  });

  it('follows focusStep from the host', () => {
    const { container } = renderEditor();
    host({ type: 'focusStep', stepId: 'needs_fix' });
    expect(card(container, 'needs_fix')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('adding blocks', () => {
  it('inserts a palette block after the selection', () => {
    const { container } = renderEditor();
    fireEvent.click(card(container, 'tests'));
    clearPosted();
    const palette = screen.getByRole('complementary', { name: 'Blocks and agents' });
    fireEvent.click(within(palette).getByRole('button', { name: /^Approval/ }));
    expect(postedOps()).toEqual([
      {
        op: 'insertStep',
        target: { parentId: 'review_loop', slot: 'steps', index: 1 },
        step: { id: 'approval_1', type: 'approval', message: 'Continue?' },
      },
    ]);
  });

  it('inserts an agent block for a palette agent at the end without a selection', () => {
    renderEditor();
    clearPosted();
    const agents = screen.getByRole('list', { name: 'Agents' });
    fireEvent.click(within(agents).getByRole('button', { name: /^Reviewer/ }));
    expect(postedOps()).toEqual([
      {
        op: 'insertStep',
        target: { parentId: null, slot: 'steps', index: 2 },
        step: { id: 'agent_1', type: 'agent', agent: 'reviewer', prompt: '' },
      },
    ]);
  });

  it('opens the block picker from an insertion point', () => {
    const { container } = renderEditor();
    clearPosted();
    fireEvent.click(screen.getAllByRole('button', { name: 'Add block here' })[1]);
    const menu = screen.getByRole('menu', { name: 'Add block' });
    expect(within(menu).getByRole('menuitem', { name: /Break/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Loop/ }));
    expect(postedOps()).toEqual([
      expect.objectContaining({
        op: 'insertStep',
        target: { parentId: null, slot: 'steps', index: 1 },
        step: { id: 'loop_1', type: 'loop', maxIterations: 5, steps: [] },
      }),
    ]);
    expect(screen.queryByRole('menu', { name: 'Add block' })).not.toBeInTheDocument();
    // The new block stays selected once the host sends the updated document.
    host({ type: 'document', doc: docFor(applyWorkflowOps(REVIEW_TEXT, postedOps() as WorkflowOp[]).text) });
    expect(card(container, 'loop_1')).toHaveAttribute('aria-pressed', 'true');
  });

  it('collapses the palette to an icon rail and back', () => {
    renderEditor();
    const palette = screen.getByRole('complementary', { name: 'Blocks and agents' });
    const toggle = within(palette).getByRole('button', { name: /the palette/ });
    const wasRail = palette.className.includes('wf-palette--rail');
    fireEvent.click(toggle);
    expect(palette.className.includes('wf-palette--rail')).toBe(!wasRail);
  });
});

describe('YAML that cannot be read', () => {
  it('keeps the last valid workflow on the canvas and offers Show in YAML', () => {
    const { container } = renderEditor();
    host({ type: 'document', doc: docFor(REVIEW_TEXT.replace('steps:\n', 'steps:\n   broken: [\n')) });
    expect(screen.getByText(/The YAML can.t be read:/)).toBeInTheDocument();
    expect(card(container, 'implement')).toBeInTheDocument();
    expect(container.querySelector('.wf-river--stale')).not.toBeNull();
    clearPosted();
    fireEvent.click(screen.getByRole('button', { name: 'Show in YAML' }));
    expect(posted()).toEqual([{ type: 'openYaml' }]);
  });
});
