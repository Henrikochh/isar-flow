import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Diagnostic, SimulationFile } from '@isar-flow/core';
import { SimulationSection } from '../../../src/views/workflow/simulation/SimulationSection';
import {
  docFor,
  fromHost,
  posted,
  REVIEW_LOOP,
  renderInspector,
  renderLive,
  resetPosted,
  simulation,
} from '../live/helpers';

const FILE: SimulationFile = {
  version: 1,
  blocks: {
    tests: [
      { exitCode: 1, output: '1 failed' },
      { exitCode: 0, output: '32 passed' },
    ],
    review: [
      { json: { approved: false, issues: ['Missing test'] } },
      { json: { approved: true, issues: [] } },
    ],
  },
};

const APPROVAL_DOC = docFor(`version: 1
name: Ship
steps:
  - id: ship
    type: approval
    message: Ship it?
`);

beforeEach(() => {
  resetPosted();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function open(stepId: string, file: SimulationFile = FILE, extra: Parameters<typeof simulation>[1] = {}) {
  const utils = renderInspector({ selection: stepId });
  fromHost({ type: 'simulation', simulation: simulation(file, extra) });
  return utils;
}

const section = () => screen.getByRole('button', { name: /^Simulation/ });
const call = (n: number) => screen.getByRole('group', { name: `Call ${n}` });
const mocks = () => posted('setSimulationMocks');
const idle = () =>
  act(() => {
    vi.advanceTimersByTime(350);
  });

describe('Simulation section', () => {
  it('is missing until the host sends the simulation state, and for blocks without host calls', () => {
    renderInspector({ selection: 'tests' });
    expect(screen.queryByRole('button', { name: /^Simulation/ })).toBeNull();
    fromHost({ type: 'simulation', simulation: simulation(FILE) });
    expect(section()).toBeInTheDocument();
  });

  it('keeps the results a real list: one item per call, each a named group', () => {
    open('tests');
    const list = call(1).closest('ol') as HTMLElement;
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByRole('group', { name: 'Call 1' })).toBeInTheDocument();
    expect(within(items[1]).getByRole('group', { name: 'Call 2' })).toBeInTheDocument();
  });

  it.each(['review_loop', 'needs_fix'])('is not offered for %s', (stepId) => {
    open(stepId);
    expect(screen.queryByRole('button', { name: /^Simulation/ })).toBeNull();
  });

  it('lists the results of a console block, the last one repeating', () => {
    open('tests');
    expect(section()).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText(
        'What this block returns when you simulate, one result per call. The last one repeats.',
      ),
    ).toBeInTheDocument();
    expect(within(call(1)).getByLabelText('Exit code')).toHaveValue('1');
    expect(within(call(1)).getByLabelText('Output')).toHaveValue('1 failed');
    expect(within(call(1)).queryByText('Repeats')).toBeNull();
    expect(within(call(2)).getByLabelText('Exit code')).toHaveValue('0');
    expect(within(call(2)).getByText('Repeats')).toBeInTheDocument();
    expect(within(call(1)).getByRole('button', { name: 'Move call 1 up' })).toBeDisabled();
    expect(within(call(2)).getByRole('button', { name: 'Move call 2 down' })).toBeDisabled();
  });

  it('commits an exit code after a pause with the exact mocks', () => {
    open('tests');
    fireEvent.change(within(call(1)).getByLabelText('Exit code'), { target: { value: '2' } });
    expect(mocks()).toEqual([]);
    idle();
    expect(mocks()).toEqual([
      {
        type: 'setSimulationMocks',
        stepId: 'tests',
        results: [
          { exitCode: 2, output: '1 failed' },
          { exitCode: 0, output: '32 passed' },
        ],
      },
    ]);
  });

  it('commits on blur', () => {
    open('tests');
    const output = within(call(2)).getByLabelText('Output');
    fireEvent.change(output, { target: { value: '32 passed\n0 failed' } });
    fireEvent.blur(output);
    expect(mocks()).toHaveLength(1);
    expect(mocks()[0].results).toEqual([
      { exitCode: 1, output: '1 failed' },
      { exitCode: 0, output: '32 passed\n0 failed' },
    ]);
    idle();
    expect(mocks()).toHaveLength(1);
  });

  it('does not save an exit code that is not a whole number', () => {
    open('tests');
    const code = within(call(1)).getByLabelText('Exit code');
    fireEvent.change(code, { target: { value: '1.5' } });
    fireEvent.blur(code);
    idle();
    expect(within(call(1)).getByText('Enter a whole number.')).toBeInTheDocument();
    expect(mocks()).toEqual([]);
  });

  it('adds, moves and removes results', () => {
    open('tests');
    fireEvent.click(screen.getByRole('button', { name: 'Add result' }));
    expect(mocks().at(-1)?.results).toEqual([...(FILE.blocks?.tests ?? []), {}]);
    expect(within(call(3)).getByLabelText('Exit code')).toHaveValue('');
    expect(within(call(3)).getByLabelText('Exit code')).toHaveAttribute('placeholder', '0');
    expect(within(call(3)).getByText('Repeats')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Move call 2 up' }));
    expect(mocks().at(-1)?.results).toEqual([
      { exitCode: 0, output: '32 passed' },
      { exitCode: 1, output: '1 failed' },
      {},
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove call 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove call 1' }));
    expect(mocks().at(-1)?.results).toEqual([{ exitCode: 1, output: '1 failed' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove call 1' }));
    expect(mocks().at(-1)).toEqual({ type: 'setSimulationMocks', stepId: 'tests', results: null });
    expect(screen.getByText('Without results, Simulate uses exit code 0 and no output.')).toBeInTheDocument();
  });

  it('writes an exit code of 0 only when it is typed', () => {
    open('tests', { blocks: {} });
    fireEvent.click(section());
    fireEvent.click(screen.getByRole('button', { name: 'Add result' }));
    expect(mocks().at(-1)?.results).toEqual([{}]);
    fireEvent.change(within(call(1)).getByLabelText('Exit code'), { target: { value: '0' } });
    idle();
    expect(mocks().at(-1)?.results).toEqual([{ exitCode: 0 }]);
  });

  it('fails a call with a message and brings the values back when it is turned off', () => {
    open('tests');
    fireEvent.click(within(call(1)).getByRole('switch', { name: 'Fail this call' }));
    expect(mocks().at(-1)?.results).toEqual([
      { error: 'Simulated failure' },
      { exitCode: 0, output: '32 passed' },
    ]);
    expect(within(call(1)).queryByLabelText('Exit code')).toBeNull();
    const message = within(call(1)).getByLabelText('Error message');
    expect(message).toHaveValue('Simulated failure');
    fireEvent.change(message, { target: { value: 'Disk full' } });
    idle();
    expect((mocks().at(-1)?.results as unknown[])[0]).toEqual({ error: 'Disk full' });

    fireEvent.click(within(call(1)).getByRole('switch', { name: 'Fail this call' }));
    expect((mocks().at(-1)?.results as unknown[])[0]).toEqual({ exitCode: 1, output: '1 failed' });
    expect(within(call(1)).getByLabelText('Exit code')).toHaveValue('1');
  });

  it('edits text answers and names the default', () => {
    open('implement');
    // No mocks yet: the section starts closed.
    expect(section()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(section());
    expect(screen.getByText('Without results, the agent answers "(simulated answer)".')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add result' }));
    fireEvent.change(within(call(1)).getByLabelText('Answer'), { target: { value: 'Done.' } });
    idle();
    expect(mocks().at(-1)).toEqual({
      type: 'setSimulationMocks',
      stepId: 'implement',
      results: [{ text: 'Done.' }],
    });
  });

  it('edits JSON answers and does not save invalid JSON', () => {
    open('review');
    const answer = within(call(1)).getByLabelText('Answer (JSON)');
    expect(answer).toHaveValue('{\n  "approved": false,\n  "issues": [\n    "Missing test"\n  ]\n}');
    fireEvent.change(answer, { target: { value: '{ "approved": true, ' } });
    fireEvent.blur(answer);
    idle();
    expect(within(call(1)).getByText(/^Not valid JSON: /)).toBeInTheDocument();
    expect(mocks()).toEqual([]);

    fireEvent.change(answer, { target: { value: '{ "approved": true, "issues": [] }' } });
    fireEvent.blur(answer);
    expect(mocks().at(-1)?.results).toEqual([
      { json: { approved: true, issues: [] } },
      { json: { approved: true, issues: [] } },
    ]);
  });

  it('starts new JSON results with sample JSON from the JSON fields', () => {
    open('review', { blocks: {} });
    fireEvent.click(section());
    expect(
      screen.getByText('Without results, the agent answers with sample JSON built from its JSON fields.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/"issues": \[\]/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add result' }));
    expect(mocks().at(-1)?.results).toEqual([{ json: { approved: true, issues: [] } }]);
    expect(within(call(1)).getByLabelText('Answer (JSON)')).toHaveValue(
      '{\n  "approved": true,\n  "issues": []\n}',
    );
  });

  it('edits approval decisions', () => {
    renderInspector({ selection: 'ship', doc: APPROVAL_DOC });
    fromHost({ type: 'simulation', simulation: simulation({ approvals: 'reject' }) });
    fireEvent.click(section());
    expect(screen.getByText('Without results, the approval is rejected.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add result' }));
    expect(mocks().at(-1)?.results).toEqual([{ approved: false }]);
    fireEvent.click(within(call(1)).getByRole('radio', { name: 'Approve' }));
    expect(mocks().at(-1)?.results).toEqual([{ approved: true }]);
    fireEvent.change(within(call(1)).getByLabelText('Comment'), { target: { value: 'Ship it' } });
    idle();
    expect(mocks().at(-1)?.results).toEqual([{ approved: true, comment: 'Ship it' }]);
  });

  it('names the approval default', () => {
    renderInspector({ selection: 'ship', doc: APPROVAL_DOC });
    fromHost({ type: 'simulation', simulation: simulation({}) });
    fireEvent.click(section());
    expect(screen.getByText('Without results, the approval is approved.')).toBeInTheDocument();
  });

  it('shows the warnings of this block', () => {
    const warning = (stepId: string, message: string): Diagnostic => ({
      severity: 'warning',
      code: 'sim-field-mismatch',
      message,
      stepId,
    });
    open('tests', FILE, {
      diagnostics: [
        warning(
          'tests',
          'Result 1 of "tests": json doesn\'t apply to console blocks. Use exitCode and output.',
        ),
        warning('deploy', 'No block "deploy" in this workflow. Remove its mocks or fix the id.'),
      ],
    });
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Result 1 of "tests": json doesn\'t apply to console blocks.');
    expect(screen.queryByText(/No block "deploy"/)).toBeNull();
  });

  it('explains file errors and offers to open the file', () => {
    open(
      'tests',
      {},
      {
        diagnostics: [
          {
            severity: 'error',
            code: 'yaml-syntax',
            message: "The YAML can't be read: bad indentation (line 3)",
          },
        ],
      },
    );
    expect(section()).toHaveAttribute('aria-expanded', 'true');
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent("The simulation file has errors, so Simulate won't start.");
    expect(banner).toHaveTextContent('bad indentation (line 3)');
    // Editing would overwrite what the file can't show; it waits until the file is fixed.
    expect(screen.queryByRole('button', { name: 'Add result' })).toBeNull();
    fireEvent.click(within(banner).getByRole('button', { name: 'Open simulation file' }));
    expect(posted()).toEqual([{ type: 'openSimulationFile' }]);
  });

  it('opens the simulation file from the link at the end', () => {
    open('tests', FILE, { exists: false });
    fireEvent.click(screen.getByRole('button', { name: 'Open simulation file' }));
    expect(posted()).toEqual([{ type: 'openSimulationFile' }]);
  });

  it('commits a pending edit to the renamed block', () => {
    const { rerender } = renderLive(
      <SimulationSection stepId="tests" step={{ id: 'tests', type: 'console' }} />,
    );
    fromHost({ type: 'simulation', simulation: simulation(FILE) });
    fireEvent.change(within(call(1)).getByLabelText('Exit code'), { target: { value: '5' } });
    rerender(<SimulationSection stepId="checks" step={{ id: 'checks', type: 'console' }} />);
    idle();
    expect(mocks().map((m) => m.stepId)).toEqual(['checks']);
  });

  it('keeps the rows of a block while its rename is on the way', () => {
    const doc = docFor(
      REVIEW_LOOP.replace('- id: tests', '- id: checks').replaceAll('steps.tests', 'steps.checks'),
    );
    renderInspector({ selection: 'checks', doc, renamedFrom: { checks: 'tests' } });
    fromHost({ type: 'simulation', simulation: simulation(FILE) });
    expect(within(call(1)).getByLabelText('Exit code')).toHaveValue('1');
  });

  it('keeps the focus on the rows when they are added, moved and removed', () => {
    open('tests');
    fireEvent.click(screen.getByRole('button', { name: 'Add result' }));
    expect(within(call(3)).getByLabelText('Exit code')).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Move call 2 up' }));
    expect(screen.getByRole('button', { name: 'Move call 1 down' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Move call 1 down' }));
    expect(screen.getByRole('button', { name: 'Move call 2 down' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Remove call 2' }));
    // The next row moves up to number 2 and takes the focus.
    expect(screen.getByRole('button', { name: 'Remove call 2' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Remove call 2' }));
    expect(screen.getByRole('button', { name: 'Remove call 1' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Remove call 1' }));
    expect(screen.getByRole('button', { name: 'Add result' })).toHaveFocus();
  });

  it('focuses the decision of a new approval result', () => {
    renderInspector({ selection: 'ship', doc: APPROVAL_DOC });
    fromHost({ type: 'simulation', simulation: simulation({}) });
    fireEvent.click(section());
    fireEvent.click(screen.getByRole('button', { name: 'Add result' }));
    expect(within(call(1)).getByRole('radio', { name: 'Approve' })).toHaveFocus();
  });
});
