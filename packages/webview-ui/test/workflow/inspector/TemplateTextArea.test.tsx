import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { TemplateTextArea, templateSegments } from '../../../src/views/workflow/inspector/TemplateTextArea';
import { fromHost, lastContext, posted, renderLive, resetPosted, shownRun } from '../live/helpers';

describe('TemplateTextArea', () => {
  it('splits text into plain runs and templates', () => {
    expect(templateSegments('Fix ${{ steps.tests.exitCode }} now')).toEqual([
      { text: 'Fix ', template: false },
      { text: '${{ steps.tests.exitCode }}', template: true },
      { text: ' now', template: false },
    ]);
    expect(templateSegments('broken ${{ steps')).toEqual([{ text: 'broken ${{ steps', template: false }]);
    expect(templateSegments('')).toEqual([]);
  });

  it('marks templates in a mirror behind the editable text', () => {
    const { container } = render(
      <TemplateTextArea aria-label="Task" value="Use ${{ inputs.task }}" onChange={() => {}} />,
    );
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('${{ inputs.task }}');
    expect(container.querySelector('[aria-hidden="true"]')).toContainElement(marks[0] as HTMLElement);
    expect(container.querySelector('textarea')).toHaveValue('Use ${{ inputs.task }}');
  });
});

const FIX = [
  'Fix ${{ toJSON(steps.review.json.issues) }} for ${{ inputs.task }}.',
  'Exit code ${{ steps.tests.exitCode }}, again ${{ steps.tests.exitCode }}.',
  'Token ${{ secrets.API_TOKEN }}, home ${{ env.HOME }}.',
].join('\n');

function field(value = FIX, liveStepId: string | null = 'fix') {
  return <TemplateTextArea aria-label="Task" value={value} liveStepId={liveStepId} onChange={() => {}} />;
}

describe('TemplateTextArea values from a run', () => {
  beforeEach(resetPosted);

  it('shows nothing without a run or without templates', () => {
    renderLive(field());
    expect(screen.queryByRole('button', { name: /Values from/ })).toBeNull();
    fromHost({ type: 'lastRunContext', context: lastContext() });
    expect(screen.getByRole('button', { name: 'Values from the last run (5)' })).toBeInTheDocument();
  });

  it('shows nothing for text without templates', () => {
    renderLive(field('Plain text'));
    fromHost({ type: 'lastRunContext', context: lastContext() });
    expect(screen.queryByRole('button', { name: /Values from/ })).toBeNull();
  });

  it('lists each distinct template once, collapsed until opened', () => {
    renderLive(field());
    fromHost({ type: 'lastRunContext', context: lastContext() });
    const toggle = screen.getByRole('button', { name: 'Values from the last run (5)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'Values from the last run' })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: 'Values from the last run' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('code')?.textContent)).toEqual([
      'toJSON(steps.review.json.issues)',
      'inputs.task',
      'steps.tests.exitCode',
      'secrets.API_TOKEN',
      'env.HOME',
    ]);
    expect(rows[1]).toHaveTextContent('Add a dark mode toggle');
    expect(rows[3]).toHaveTextContent('••••••');
    // No value to copy for templates a run does not keep.
    expect(rows[4]).toHaveTextContent("Environment values aren't saved with runs.");
    expect(within(rows[4]).queryByRole('button', { name: /Copy value/ })).toBeNull();
  });

  it('copies a value', () => {
    renderLive(field());
    fromHost({ type: 'lastRunContext', context: lastContext() });
    fireEvent.click(screen.getByRole('button', { name: 'Values from the last run (5)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy value of steps.tests.exitCode' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy value of toJSON(steps.review.json.issues)' }));
    expect(posted('copyToClipboard')).toEqual([
      { type: 'copyToClipboard', text: '1' },
      { type: 'copyToClipboard', text: '[\n  "Missing test",\n  "Typo in label"\n]' },
    ]);
  });

  it('shows the full value of a row with its type and notes', () => {
    const long = 'x'.repeat(3000);
    renderLive(field('Output: ${{ steps.tests.output }}'));
    fromHost({
      type: 'lastRunContext',
      context: lastContext({
        steps: { tests: { status: 'success', exitCode: 0, output: `${long.slice(0, 2048)}…` } },
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Values from the last run (1)' }));
    const row = screen.getByRole('button', { name: /^steps\.tests\.output/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const detail = document.getElementById(row.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(within(detail).getByText('Text')).toBeInTheDocument();
    expect(within(detail).getByText('Showing the first 2 KB.')).toBeInTheDocument();
    expect(detail.querySelector('pre')?.textContent?.length).toBeLessThanOrEqual(2049);
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  it('reads the shown run', () => {
    renderLive(field('Code ${{ steps.tests.exitCode }}'), { run: shownRun() });
    fireEvent.click(screen.getByRole('button', { name: 'Values from this run (1)' }));
    expect(screen.getByRole('list', { name: 'Values from this run' })).toHaveTextContent('0');
  });

  it('says when the values come from a simulation', () => {
    renderLive(field('Code ${{ steps.tests.exitCode }}'));
    fromHost({ type: 'lastRunContext', context: lastContext({ simulated: true }) });
    fireEvent.click(screen.getByRole('button', { name: 'Values from the last simulation (1)' }));
    expect(screen.getByRole('list', { name: 'Values from the last simulation' })).toBeInTheDocument();
  });

  it('says when the shown run is a simulation', () => {
    renderLive(field('Code ${{ steps.tests.exitCode }}'), { run: { ...shownRun(), simulated: true } });
    expect(screen.getByRole('button', { name: 'Values from this simulation (1)' })).toBeInTheDocument();
  });

  it('follows the text while it is typed', () => {
    function Typing() {
      const [value, setValue] = useState('A ${{ inputs.task }}');
      return (
        <TemplateTextArea
          aria-label="Task"
          value={value}
          liveStepId="fix"
          onChange={(event) => setValue(event.target.value)}
        />
      );
    }
    renderLive(<Typing />);
    fromHost({ type: 'lastRunContext', context: lastContext() });
    expect(screen.getByRole('button', { name: 'Values from the last run (1)' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Task'), {
      target: { value: 'A ${{ inputs.task }} ${{ steps.implement.text }}' },
    });
    expect(screen.getByRole('button', { name: 'Values from the last run (2)' })).toBeInTheDocument();
  });

  it('reads loop values in the scope of the block', () => {
    renderLive(field('Round ${{ loop.iteration }}', 'tests'));
    fromHost({ type: 'lastRunContext', context: lastContext() });
    fireEvent.click(screen.getByRole('button', { name: 'Values from the last run (1)' }));
    expect(screen.getByRole('button', { name: /^loop\.iteration/ })).toHaveTextContent('5');
  });
});
