/**
 * The host sends a lenient model when the YAML does not match the schema: any field may be missing or have the
 * wrong type. The whole editor (canvas, inspector, top bar) must keep working on it.
 */
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { reduceRunEvent, type RunEvent, type RunView } from '@isar-flow/core';
import { docFor, host, renderEditor, stubLayout } from './canvas/helpers';

const WRONG_TYPES = `version: 1
name: [not, a, name]
description: 42
inputs: [task]
env: just text
steps:
  - id: a
    type: agent
    agent: { model: 5 }
    model: 7
    prompt: { not: text }
    output: json
    context: files
    retry: 3
    timeout: soon
    session: forever
  - id: b
    type: console
    run: [echo, hi]
    env: [A=1]
    shell: fish
    cwd: 9
    continueOnError: maybe
  - id: c
    type: loop
    until: [1, 2]
    maxIterations: lots
    onMaxIterations: explode
    steps: not a list
  - id: d
    type: if
    condition: 42
    then: {}
    else:
      - just a string
      - null
      - id: e
        type: stop
        outcome: maybe
        message: [1]
  - id: f
    type: approval
    message: 12
    onReject: { x: 1 }
  - id: g
    type: mystery
    run: echo
  - type: break
  - id: h
    type: loop
    while: { op: eq }
    maxIterations: 2
    steps:
      - id: i
        type: agent
        agent: reviewer
        output: { format: json, schema: [approved] }
      - id: j
        type: if
        condition: { any: [{ all: [{ value: 1, op: eq, to: 1 }] }] }
        then: [{ id: k, type: break }]
  - id: a
    type: console
    run: echo duplicate id
  - 17
`;

const ODD_ROOTS = [
  'version: 1\nname: x\nsteps: {}\n',
  'version: 1\nname: x\nsteps: 7\n',
  'version: 1\nsteps:\n  - null\n',
  '[]\n',
];

let errors: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  stubLayout();
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => {
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

function cards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-wf-card]'));
}

describe('lenient workflow models', () => {
  it('renders, selects and inspects every block of badly typed YAML', { timeout: 30_000 }, () => {
    errors = vi.spyOn(console, 'error');
    renderEditor(docFor(WRONG_TYPES));
    expect(cards().length).toBeGreaterThan(8);
    for (const card of cards()) {
      fireEvent.click(card);
      // Open every collapsed group so each field renders once.
      for (const toggle of screen.queryAllByRole('button', { expanded: false })) {
        if (toggle.closest('[data-wf-inspector]')) fireEvent.click(toggle);
      }
      for (const tab of screen.queryAllByRole('radio')) {
        if (tab.closest('[data-wf-inspector]') && tab.closest('.wf-cond')) fireEvent.click(tab);
      }
    }
    fireEvent.keyDown(cards()[0], { key: 'Escape' });
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument();
  });

  it('lists the variables once when two blocks share an id', () => {
    errors = vi.spyOn(console, 'error');
    renderEditor(docFor(WRONG_TYPES));
    const late = cards().find((card) => card.dataset.stepId === 'i') as HTMLElement;
    fireEvent.click(late);
    fireEvent.click(screen.getAllByRole('button', { name: 'Insert variable' })[0]);
    const options = screen.getAllByRole('option').map((o) => o.id);
    expect(new Set(options).size).toBe(options.length);
    // The condition builder lists the same variables as rule values.
    fireEvent.click(cards().find((card) => card.dataset.stepId === 'j') as HTMLElement);
    for (const radio of screen.queryAllByRole('radio', { name: 'Rules' })) fireEvent.click(radio);
  });

  // Renders the whole editor like the first test; it needs more than 5 s when the full suite loads the machine.
  it('shows a run of badly typed YAML on the canvas and in the inspector', { timeout: 30_000 }, () => {
    errors = vi.spyOn(console, 'error');
    renderEditor(docFor(WRONG_TYPES));
    const error = 'Agent block "a" has no agent.';
    const usage = { inputTokens: 0, outputTokens: 0 };
    const events: RunEvent[] = [
      { type: 'run-start', runId: 'r', workflowName: 'x', startedAt: 1, inputs: {} },
      { type: 'step-start', runId: 'r', stepId: 'a', stepType: 'agent', at: 2 },
      { type: 'step-log', runId: 'r', stepId: 'a', stream: 'stderr', text: error },
      {
        type: 'step-end',
        runId: 'r',
        stepId: 'a',
        status: 'failure',
        output: { status: 'failure', error },
        error,
        durationMs: 1,
        at: 3,
      },
      { type: 'step-start', runId: 'r', stepId: 'h', stepType: 'loop', at: 4 },
      { type: 'loop-iteration', runId: 'r', stepId: 'h', iteration: 1, maxIterations: 2 },
      { type: 'run-end', runId: 'r', status: 'failure', error, durationMs: 4, usage },
    ];
    const run = events.reduce<RunView | null>((view, event) => reduceRunEvent(view, event), null);
    host({ type: 'run', run, live: false });
    for (const card of cards()) fireEvent.click(card);
    fireEvent.keyDown(cards()[0], { key: 'Escape' });
    expect(screen.getAllByText(/Failed/).length).toBeGreaterThan(0);
  });

  it.each(ODD_ROOTS)('survives a workflow whose steps are not a list of blocks: %j', (text) => {
    errors = vi.spyOn(console, 'error');
    renderEditor(docFor(text));
    expect(screen.getByRole('region', { name: 'Workflow canvas' })).toBeInTheDocument();
  });
});
