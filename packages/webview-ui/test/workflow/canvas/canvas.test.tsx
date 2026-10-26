import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  applyWorkflowOps,
  reduceRunEvent,
  type RunEvent,
  type RunView,
  type WorkflowOp,
} from '@isar-flow/core';
import { AGENTS, CATALOG } from '../../../harness/fixtures';
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
    // Each edit shows at once, so the copy is the block that follows the deleted one.
    expect(card(container, 'tests_2')).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('[data-step-id="tests"]')).toBeNull();
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

  it('offers each agent id once, leaving out agents another one hides', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderEditor();
    const [coder, reviewer] = AGENTS;
    // A second workspace folder with its own coder, and a user reviewer hidden by the workspace one.
    const agents = [
      ...AGENTS,
      { ...coder, uri: 'file:///c%3A/work/api/.isarflow/agents/coder.agent.yaml', shadowed: true },
      {
        ...reviewer,
        scope: 'user' as const,
        uri: 'file:///c%3A/Users/me/agents/reviewer.agent.yaml',
        shadowed: true,
      },
    ];
    host({ type: 'catalog', agents, catalog: CATALOG });
    const list = screen.getByRole('list', { name: 'Agents' });
    expect(within(list).getAllByRole('button')).toHaveLength(AGENTS.length);
    for (const agent of AGENTS) {
      expect(within(list).getAllByRole('button', { name: new RegExp(`^${agent.name}`) })).toHaveLength(1);
    }
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
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

describe('blocks without ids', () => {
  const NO_IDS =
    'version: 1\nname: Broken\nsteps:\n  - type: console\n    run: ls\n  - id: again\n    type: loop\n    maxIterations: 2\n    steps:\n      - type: console\n        run: ls\n';

  it('offers to add the missing ids, and the banner goes once they are there', () => {
    renderEditor(docFor(NO_IDS));
    expect(
      screen.getByText('2 blocks have no id. Blocks need ids before they can be edited or referenced.'),
    ).toBeInTheDocument();
    clearPosted();
    fireEvent.click(screen.getByRole('button', { name: 'Add ids' }));
    expect(postedOps()).toEqual([{ op: 'assignMissingIds' }]);
    host({ type: 'document', doc: docFor(applyWorkflowOps(NO_IDS, [{ op: 'assignMissingIds' }]).text) });
    expect(screen.queryByText(/no id\./)).not.toBeInTheDocument();
  });

  it('counts ids that break the id rule, in the singular for one block', () => {
    renderEditor(docFor('version: 1\nname: W\nsteps:\n  - id: 2fast\n    type: console\n    run: ls\n'));
    expect(screen.getByText(/^1 block has no valid id\./)).toBeInTheDocument();
  });

  it('shows no banner while the YAML cannot be read', () => {
    renderEditor(docFor(NO_IDS));
    host({ type: 'document', doc: docFor(NO_IDS.replace('steps:\n', 'steps:\n   broken: [\n')) });
    expect(screen.queryByText(/no id\./)).not.toBeInTheDocument();
  });
});

describe('block menu and Move to', () => {
  const items = (menu: HTMLElement) =>
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => [item.textContent, item.getAttribute('aria-disabled') === 'true']);

  it('opens on right-click with the block actions and selects the block', () => {
    const { container } = renderEditor();
    fireEvent.contextMenu(card(container, 'tests'));
    expect(card(container, 'tests')).toHaveAttribute('aria-pressed', 'true');
    const menu = screen.getByRole('menu', { name: 'Block actions' });
    clearPosted();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Duplicate/ }));
    expect(postedOps()).toEqual([{ op: 'duplicateStep', stepId: 'tests' }]);
    expect(screen.queryByRole('menu', { name: 'Block actions' })).not.toBeInTheDocument();

    fireEvent.contextMenu(card(container, 'tests'));
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Block actions' })).getByRole('menuitem', { name: /Delete/ }),
    );
    expect(postedOps()).toEqual([
      { op: 'duplicateStep', stepId: 'tests' },
      { op: 'deleteStep', stepId: 'tests' },
    ]);
    // Each edit shows at once, so the copy is the block that follows the deleted one.
    expect(card(container, 'tests_2')).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('[data-step-id="tests"]')).toBeNull();
  });

  it('opens from the keyboard with Shift+F10 and shows the actions there', () => {
    const { container } = renderEditor();
    fireEvent.click(card(container, 'implement'));
    fireEvent.keyDown(card(container, 'implement'), { key: 'F10', shiftKey: true });
    const menu = screen.getByRole('menu', { name: 'Block actions' });
    clearPosted();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Show in YAML/ }));
    expect(posted()).toEqual([{ type: 'openYaml', stepId: 'implement' }]);
  });

  it('lists every list the block can move to, never one inside itself', () => {
    const { container } = renderEditor();
    fireEvent.contextMenu(card(container, 'implement'));
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Block actions' })).getByRole('menuitem', { name: /Move to/ }),
    );
    expect(items(screen.getByRole('menu', { name: 'Move to' }))).toEqual([
      ['Top levelEnd of the workflow', false],
      ['review_loopEnd of the loop', false],
      ['needs_fixEnd of Then', false],
      ['needs_fixEnd of Else', false],
    ]);

    fireEvent.keyDown(screen.getByRole('menu', { name: 'Move to' }), { key: 'Escape' });
    fireEvent.contextMenu(card(container, 'review_loop'));
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Block actions' })).getByRole('menuitem', { name: /Move to/ }),
    );
    // The loop is last at the top level already and cannot go into its own body or the If inside it.
    expect(items(screen.getByRole('menu', { name: 'Move to' }))).toEqual([
      ['Top levelAlready the last block here', true],
    ]);
  });

  it('moves the block to the end of the chosen list', () => {
    const { container } = renderEditor();
    fireEvent.contextMenu(card(container, 'implement'));
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Block actions' })).getByRole('menuitem', { name: /Move to/ }),
    );
    clearPosted();
    fireEvent.click(within(screen.getByRole('menu', { name: 'Move to' })).getAllByRole('menuitem')[3]);
    expect(postedOps()).toEqual([
      { op: 'moveStep', stepId: 'implement', target: { parentId: 'needs_fix', slot: 'else', index: 0 } },
    ]);
    expect(screen.queryByRole('menu', { name: 'Move to' })).not.toBeInTheDocument();
    expect(card(container, 'implement')).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps Break blocks inside loops', () => {
    const text =
      'version: 1\nname: W\nsteps:\n  - id: outer\n    type: loop\n    maxIterations: 2\n    steps:\n      - id: leave\n        type: break\n      - id: check\n        type: if\n        condition: "${{ true }}"\n';
    const { container } = renderEditor(docFor(text));
    fireEvent.contextMenu(card(container, 'leave'));
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Block actions' })).getByRole('menuitem', { name: /Move to/ }),
    );
    expect(items(screen.getByRole('menu', { name: 'Move to' })).map(([label]) => label)).toEqual([
      'outerEnd of the loop',
      'checkEnd of Then',
      'checkEnd of Else',
    ]);
  });

  it('has no menu for blocks without an id', () => {
    const { container } = renderEditor(
      docFor('version: 1\nname: W\nsteps:\n  - type: console\n    run: ls\n'),
    );
    const broken = container.querySelector<HTMLElement>('[data-wf-card]');
    fireEvent.contextMenu(broken as HTMLElement);
    expect(screen.queryByRole('menu', { name: 'Block actions' })).not.toBeInTheDocument();
  });
});

describe('following a live run', () => {
  const start = (stepId: string): RunEvent => ({
    type: 'step-start',
    runId: 'r',
    stepId,
    stepType: 'agent',
    at: 2,
  });
  const runningAt = (stepId: string): RunView | null =>
    [
      { type: 'run-start', runId: 'r', workflowName: 'w', startedAt: 1, inputs: {} } as RunEvent,
      start(stepId),
    ].reduce<RunView | null>((view, event) => reduceRunEvent(view, event), null);
  const scrolled = () => vi.mocked(Element.prototype.scrollIntoView);
  const canvas = () => screen.getByRole('region', { name: 'Workflow canvas' });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('scrolls the block that starts into view, smoothly', () => {
    const { container } = renderEditor();
    scrolled().mockClear();
    host({ type: 'run', run: runningAt('implement'), live: true });
    expect(scrolled().mock.contexts).toEqual([card(container, 'implement')]);
    expect(scrolled()).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    host({ type: 'runEvent', event: start('tests') });
    expect(scrolled().mock.contexts).toEqual([card(container, 'implement'), card(container, 'tests')]);
  });

  it('leaves the view alone for 5 seconds after the user scrolled', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
    const { container } = renderEditor();
    host({ type: 'run', run: runningAt('implement'), live: true });
    fireEvent.wheel(canvas());
    scrolled().mockClear();
    vi.setSystemTime(14_000);
    host({ type: 'runEvent', event: start('tests') });
    expect(scrolled()).not.toHaveBeenCalled();
    vi.setSystemTime(15_001);
    host({ type: 'runEvent', event: start('review') });
    expect(scrolled().mock.contexts).toEqual([card(container, 'review')]);
  });

  it('jumps without animation when the user prefers reduced motion', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: query.includes('reduce'), media: query }),
    });
    renderEditor();
    scrolled().mockClear();
    host({ type: 'run', run: runningAt('tests'), live: true });
    expect(scrolled()).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  });

  it('does not follow a past run', () => {
    renderEditor();
    scrolled().mockClear();
    host({ type: 'run', run: runningAt('tests'), live: false });
    expect(scrolled()).not.toHaveBeenCalled();
  });
});

describe('loops', () => {
  const FIXED =
    'version: 1\nname: W\nsteps:\n  - id: outer\n    type: loop\n    maxIterations: 3\n    steps:\n      - id: inner\n        type: loop\n        maxIterations: 2\n        until: "${{ true }}"\n        steps: []\n';
  const frame = (container: HTMLElement, id: string) => card(container, id).closest('.wf-loop');

  it('shows the iteration limit only when a condition decides when to stop', () => {
    renderEditor(docFor(FIXED));
    expect(screen.getByText('Repeat 3 times')).toBeInTheDocument();
    expect(screen.queryByText('max 3')).not.toBeInTheDocument();
    expect(screen.getByText('max 2')).toHaveAttribute('title', 'Repeats at most 2 times');
  });

  it('makes room beside nested loops for their return channel', () => {
    const { container } = renderEditor(docFor(FIXED));
    expect(frame(container, 'inner')).toHaveClass('wf-loop--nested');
    expect(frame(container, 'outer')).not.toHaveClass('wf-loop--nested');
  });
});

describe('center line', () => {
  const ONE = 'version: 1\nname: W\nsteps:\n  - id: only\n    type: console\n    run: ls\n';
  const TWO = `${ONE}  - id: second\n    type: console\n    run: ls\n`;

  /** jsdom has no layout: the canvas gets fixed sizes and a plain scroll position. */
  function fakeScroller(clientWidth: number) {
    const el = screen.getByRole('region', { name: 'Workflow canvas' });
    const size = { scrollWidth: clientWidth };
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
    Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => size.scrollWidth });
    Object.defineProperty(el, 'scrollLeft', { configurable: true, writable: true, value: 0 });
    return { el, size };
  }

  it('keeps the river centered when it grows wider than the canvas', () => {
    renderEditor(docFor(ONE));
    const { el, size } = fakeScroller(800);
    size.scrollWidth = 1200;
    host({ type: 'document', doc: docFor(REVIEW_TEXT) });
    expect(el.scrollLeft).toBe(200);
  });

  it('keeps the center line where the user scrolled it when the width changes', () => {
    renderEditor(docFor(REVIEW_TEXT));
    const { el, size } = fakeScroller(800);
    size.scrollWidth = 1200;
    host({ type: 'document', doc: docFor(ONE) });
    // The user moves the center line 50 px right of the middle, then an edit makes the river narrower.
    el.scrollLeft = 150;
    fireEvent.scroll(el);
    size.scrollWidth = 1000;
    host({ type: 'document', doc: docFor(TWO) });
    expect(el.scrollLeft).toBe(50);
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
