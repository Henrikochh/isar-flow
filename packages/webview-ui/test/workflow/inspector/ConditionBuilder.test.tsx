import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { docFor, posted, REVIEW_LOOP, renderInspector, resetPosted, sentOps } from './helpers';

beforeEach(resetPosted);
afterEach(cleanup);

const EXIT = { value: '${{ steps.tests.exitCode }}', op: 'eq', to: 0 };
const APPROVED = { value: '${{ steps.review.json.approved }}', op: 'isTrue' };

function choose(trigger: string, option: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name: trigger }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

describe('ConditionBuilder rules', () => {
  it('shows one rule per comparison with picker labels and a live summary', () => {
    renderInspector({ selection: 'review_loop' });
    expect(screen.getByRole('button', { name: 'Rule 1 value' })).toHaveTextContent('tests › exitCode');
    expect(screen.getByRole('button', { name: 'Rule 2 value' })).toHaveTextContent('review › json.approved');
    expect(screen.getByRole('button', { name: 'Rule 2 operator' })).toHaveTextContent('is true');
    // Operand-free operators hide the operand.
    expect(screen.queryByLabelText('Rule 2 compare with')).toBeNull();
    expect(screen.getByText(/tests\.exitCode = 0 and review\.json\.approved is true/)).toBeInTheDocument();
  });

  it('changes an operator and drops the operand for operand-free ones', () => {
    renderInspector({ selection: 'review_loop' });
    choose('Rule 1 operator', 'is empty');
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'review_loop', set: { until: { all: [{ value: EXIT.value, op: 'isEmpty' }, APPROVED] } } },
    ]);
  });

  it('writes typed operands', () => {
    renderInspector({ selection: 'review_loop' });
    const operand = screen.getByLabelText('Rule 1 compare with');
    fireEvent.change(operand, { target: { value: '2' } });
    fireEvent.blur(operand);
    fireEvent.change(operand, { target: { value: 'flaky' } });
    fireEvent.blur(operand);
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'review_loop', set: { until: { all: [{ ...EXIT, to: 2 }, APPROVED] } } },
      { op: 'updateStep', stepId: 'review_loop', set: { until: { all: [{ ...EXIT, to: 'flaky' }, APPROVED] } } },
    ]);
  });

  it('removes a rule and changes how rules combine', () => {
    renderInspector({ selection: 'review_loop' });
    choose('How rules combine', 'Any rule matches');
    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 2' }));
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'review_loop', set: { until: { any: [EXIT, APPROVED] } } },
      { op: 'updateStep', stepId: 'review_loop', set: { until: EXIT } },
    ]);
  });

  it('adds a rule once a value is chosen, defaulting booleans to "is true"', () => {
    renderInspector({ selection: 'review_loop' });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(sentOps()).toEqual([]);
    choose('Rule 3 value', /^tests › timedOut/);
    expect(sentOps()).toEqual([
      {
        op: 'updateStep',
        stepId: 'review_loop',
        set: { until: { all: [EXIT, APPROVED, { value: '${{ steps.tests.timedOut }}', op: 'isTrue' }] } },
      },
    ]);
  });

  it('accepts a custom value typed into the picker', () => {
    renderInspector({ selection: 'review_loop' });
    fireEvent.click(screen.getByRole('button', { name: 'Rule 1 value' }));
    const filter = screen.getByLabelText('Filter options');
    fireEvent.change(filter, { target: { value: 'steps.tests.stdout' } });
    fireEvent.click(screen.getByRole('option', { name: 'Use "steps.tests.stdout"' }));
    expect(sentOps()).toEqual([
      {
        op: 'updateStep',
        stepId: 'review_loop',
        set: { until: { all: [{ ...EXIT, value: '${{ steps.tests.stdout }}' }, APPROVED] } },
      },
    ]);
  });

  it('starts an if block created by the canvas with an empty rule', () => {
    const text = REVIEW_LOOP.replace(
      '        condition: "${{ !steps.review.json.approved || steps.tests.exitCode != 0 }}"',
      '        condition: "${{ true }}"',
    );
    renderInspector({ doc: docFor(text), selection: 'needs_fix' });
    expect(screen.getByRole('radio', { name: 'Rules' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Rule 1 value' })).toHaveTextContent('Choose a value');
    choose('Rule 1 operator', 'is at least');
    const operand = screen.getByLabelText('Rule 1 compare with');
    fireEvent.change(operand, { target: { value: '1' } });
    fireEvent.blur(operand);
    expect(sentOps()).toEqual([]);
    choose('Rule 1 value', /^tests › exitCode/);
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'needs_fix', set: { condition: { value: '${{ steps.tests.exitCode }}', op: 'gte', to: 1 } } },
    ]);
  });
});

describe('ConditionBuilder expressions', () => {
  it('opens expressions in Expression mode and reports parse errors inline', () => {
    renderInspector({ selection: 'needs_fix' });
    const expression = screen.getByLabelText('Expression');
    expect(expression).toHaveValue('!steps.review.json.approved || steps.tests.exitCode != 0');
    fireEvent.change(expression, { target: { value: 'steps.tests.exitCode !=' } });
    expect(screen.getByText(/Unexpected end of expression/)).toBeInTheDocument();
    fireEvent.change(expression, { target: { value: 'steps.tests.exitCode > 1' } });
    fireEvent.blur(expression);
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'needs_fix', set: { condition: '${{ steps.tests.exitCode > 1 }}' } },
    ]);
  });

  it('shows a simple expression as rules and writes rules once edited', () => {
    renderInspector({ selection: 'needs_fix' });
    fireEvent.click(screen.getByRole('radio', { name: 'Rules' }));
    expect(screen.getByRole('button', { name: 'How rules combine' })).toHaveTextContent('Any rule matches');
    expect(screen.getByRole('button', { name: 'Rule 1 operator' })).toHaveTextContent('is false');
    expect(screen.getByText(/review\.json\.approved is false or tests\.exitCode ≠ 0/)).toBeInTheDocument();
    expect(sentOps()).toEqual([]);
    choose('Rule 2 operator', 'is greater than');
    expect(sentOps()).toEqual([
      {
        op: 'updateStep',
        stepId: 'needs_fix',
        set: {
          condition: {
            any: [
              { value: '${{ steps.review.json.approved }}', op: 'isFalse' },
              { value: '${{ steps.tests.exitCode }}', op: 'gt', to: 0 },
            ],
          },
        },
      },
    ]);
  });

  it('prefills the expression editor from rules without writing', () => {
    renderInspector({ selection: 'review_loop' });
    fireEvent.click(screen.getByRole('radio', { name: 'Expression' }));
    expect(screen.getByLabelText('Expression')).toHaveValue('steps.tests.exitCode == 0 && steps.review.json.approved');
    expect(sentOps()).toEqual([]);
  });

  it('offers to start over when an expression cannot be shown as rules', () => {
    const text = REVIEW_LOOP.replace(
      '"${{ !steps.review.json.approved || steps.tests.exitCode != 0 }}"',
      '"${{ steps.tests.exitCode == 0 && steps.review.json.approved || loop.iteration > 3 }}"',
    );
    renderInspector({ doc: docFor(text), selection: 'needs_fix' });
    fireEvent.click(screen.getByRole('radio', { name: 'Rules' }));
    expect(screen.getByText("This expression can't be shown as rules.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start over with rules' }));
    expect(screen.getByRole('button', { name: 'Rule 1 value' })).toHaveTextContent('Choose a value');
    expect(sentOps()).toEqual([]);
  });

  it('sends nested conditions to the YAML', () => {
    const text = REVIEW_LOOP.replace(
      '        - { value: "${{ steps.review.json.approved }}", op: isTrue }',
      '        - any: [{ value: "${{ steps.review.json.approved }}", op: isTrue }, { value: "${{ loop.iteration }}", op: gt, to: 3 }]',
    );
    renderInspector({ doc: docFor(text), selection: 'review_loop' });
    expect(screen.getByText('This condition has nested groups. Edit it in YAML.')).toBeInTheDocument();
    expect(screen.getByText(/tests\.exitCode = 0 and \(review\.json\.approved is true or loop\.iteration > 3\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open YAML' }));
    expect(posted()).toContainEqual({ type: 'openYaml', stepId: 'review_loop' });
  });

  it('inserts bare expressions from the variable picker', () => {
    renderInspector({ selection: 'needs_fix' });
    const expression = screen.getByLabelText('Expression') as HTMLTextAreaElement;
    fireEvent.change(expression, { target: { value: ' > 0' } });
    expression.setSelectionRange(0, 0);
    fireEvent.blur(expression);
    fireEvent.click(screen.getByRole('button', { name: 'Insert variable' }));
    fireEvent.click(screen.getByText('loop.iteration'));
    expect(expression.value).toBe('loop.iteration > 0');
  });
});
