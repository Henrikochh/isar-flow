import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { docFor, posted, REVIEW_LOOP, renderInspector, resetPosted, sentOps } from './helpers';

beforeEach(resetPosted);
afterEach(cleanup);

describe('Inspector without a selection', () => {
  it('shows the workflow settings and commits the name on blur', () => {
    renderInspector();
    const name = screen.getByLabelText('Name');
    expect(name).toHaveValue('Review until approved');
    fireEvent.change(name, { target: { value: 'Ship vouchers' } });
    expect(sentOps()).toEqual([]);
    fireEvent.blur(name);
    expect(sentOps()).toEqual([{ op: 'updateWorkflow', set: { name: 'Ship vouchers' } }]);
  });

  it('edits inputs and keeps their key order', () => {
    renderInspector();
    const description = screen.getByLabelText('Description of task');
    fireEvent.change(description, { target: { value: 'What to build' } });
    fireEvent.blur(description);
    expect(sentOps()).toEqual([
      {
        op: 'updateWorkflow',
        set: { inputs: { task: { type: 'string', description: 'What to build', required: true, multiline: true } } },
      },
    ]);
  });

  it('validates new input names before committing', () => {
    renderInspector();
    fireEvent.click(screen.getByRole('button', { name: 'Add input' }));
    const name = screen.getByLabelText('Name of input 2');
    fireEvent.change(name, { target: { value: '2fast' } });
    fireEvent.blur(name);
    expect(screen.getByText(/Names start with a letter/)).toBeInTheDocument();
    expect(sentOps()).toEqual([]);
    fireEvent.change(name, { target: { value: 'branch' } });
    fireEvent.blur(name);
    const [op] = sentOps();
    expect(op).toMatchObject({ op: 'updateWorkflow', set: { inputs: { task: {}, branch: { type: 'string' } } } });
  });

  it('adds environment variables', () => {
    renderInspector();
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
    fireEvent.change(screen.getByLabelText('Name of variable 1'), { target: { value: 'CI' } });
    const value = screen.getByLabelText('Value of variable 1');
    fireEvent.change(value, { target: { value: '1' } });
    fireEvent.blur(value);
    expect(sentOps()).toEqual([{ op: 'updateWorkflow', set: { env: { CI: '1' } } }]);
  });

  it('lists past runs and shows one on click', () => {
    renderInspector();
    const history = screen.getByRole('list', { name: 'Run history' });
    fireEvent.click(within(history).getAllByRole('button')[0]);
    expect(posted()).toContainEqual({ type: 'selectRun', runId: 'run-7' });
  });

  it('pauses editing quietly when the YAML cannot be read (the canvas banner explains why)', () => {
    renderInspector({ doc: { ...docFor(), workflow: null } });
    expect(screen.getByText('Editing is paused')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });
});

describe('Inspector with a block selected', () => {
  it('shows the header with the id as name placeholder', () => {
    renderInspector({ selection: 'implement' });
    expect(screen.getByLabelText('Block name')).toHaveAttribute('placeholder', 'implement');
    expect(screen.getByLabelText('Id')).toHaveValue('implement');
    expect(screen.getByText('Agent', { selector: '.wf-insp-head-type' })).toBeInTheDocument();
  });

  it('validates the id inline and renames on blur', () => {
    renderInspector({ selection: 'implement' });
    const id = screen.getByLabelText('Id');
    fireEvent.change(id, { target: { value: 'tests' } });
    expect(screen.getByText("Another block already uses the id 'tests'.")).toBeInTheDocument();
    fireEvent.blur(id);
    fireEvent.change(id, { target: { value: 'two words' } });
    expect(screen.getByText(/Ids start with a letter/)).toBeInTheDocument();
    fireEvent.blur(id);
    expect(sentOps()).toEqual([]);

    fireEvent.change(id, { target: { value: 'build' } });
    fireEvent.keyDown(id, { key: 'Enter' });
    fireEvent.blur(id);
    expect(sentOps()).toEqual([{ op: 'renameStep', stepId: 'implement', newId: 'build' }]);
    // Until the host confirms, the block stays on screen under its old id.
    expect(screen.getByLabelText('Block name')).toHaveAttribute('placeholder', 'implement');
  });

  it('runs the header actions', () => {
    renderInspector({ selection: 'tests' });
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show in YAML' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(posted()).toEqual([
      { type: 'ops', ops: [{ op: 'duplicateStep', stepId: 'tests' }] },
      { type: 'openYaml', stepId: 'tests' },
      { type: 'ops', ops: [{ op: 'deleteStep', stepId: 'tests' }] },
    ]);
    // Deleting clears the selection, so the workflow settings come back.
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('commits the task on blur and keeps typing local before that', () => {
    renderInspector({ selection: 'implement' });
    const task = screen.getByLabelText('Task');
    fireEvent.change(task, { target: { value: 'Write the docs' } });
    expect(sentOps()).toEqual([]);
    fireEvent.blur(task);
    expect(sentOps()).toEqual([{ op: 'updateStep', stepId: 'implement', set: { prompt: 'Write the docs' } }]);
  });

  it('inserts a variable at the caret', () => {
    renderInspector({ selection: 'review' });
    const task = screen.getByLabelText('Task') as HTMLTextAreaElement;
    fireEvent.change(task, { target: { value: 'Exit code: .' } });
    task.setSelectionRange(11, 11);
    fireEvent.blur(task);
    resetPosted();

    fireEvent.click(screen.getByRole('button', { name: 'Insert variable' }));
    const list = screen.getByRole('listbox', { name: 'Variables' });
    fireEvent.change(screen.getByLabelText('Search variables'), { target: { value: 'tests exit' } });
    fireEvent.click(within(list).getByText('exitCode'));
    expect(task.value).toBe('Exit code: ${{ steps.tests.exitCode }}.');
    fireEvent.blur(task);
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'review', set: { prompt: 'Exit code: ${{ steps.tests.exitCode }}.' } },
    ]);
  });

  it('only offers variables of blocks that ran before', () => {
    renderInspector({ selection: 'implement' });
    fireEvent.click(screen.getByRole('button', { name: 'Insert variable' }));
    const list = screen.getByRole('listbox', { name: 'Variables' });
    expect(within(list).getByText('inputs.task')).toBeInTheDocument();
    expect(within(list).queryByText('exitCode')).toBeNull();
  });

  it('switches the answer format to JSON', () => {
    renderInspector({ selection: 'implement' });
    fireEvent.click(screen.getByRole('radio', { name: 'JSON' }));
    expect(sentOps()).toEqual([{ op: 'updateStep', stepId: 'implement', set: { output: { format: 'json' } } }]);
  });

  it('edits JSON fields as rows', () => {
    renderInspector({ selection: 'review' });
    expect(screen.getByLabelText('Name of field 1')).toHaveValue('approved');
    fireEvent.click(screen.getByRole('button', { name: 'Type of issues' }));
    fireEvent.click(screen.getByRole('option', { name: 'Text' }));
    fireEvent.click(screen.getByText('approved is optional'));
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'review', set: { output: { format: 'json', schema: { approved: 'boolean', issues: 'string' } } } },
      {
        op: 'updateStep',
        stepId: 'review',
        set: { output: { format: 'json', schema: { 'approved?': 'boolean', issues: 'string' } } },
      },
    ]);
  });

  it('chooses an agent or no agent', () => {
    renderInspector({ selection: 'implement' });
    fireEvent.click(screen.getByLabelText('Agent'));
    fireEvent.click(screen.getByRole('option', { name: /Reviewer/ }));
    fireEvent.click(screen.getByLabelText('Agent'));
    fireEvent.click(screen.getByRole('option', { name: /No agent/ }));
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'implement', set: { agent: 'reviewer' } },
      { op: 'updateStep', stepId: 'implement', set: {}, unset: ['agent'] },
    ]);
  });

  it('edits console settings', () => {
    renderInspector({ selection: 'tests' });
    fireEvent.click(screen.getByLabelText('Shell'));
    fireEvent.click(screen.getByRole('option', { name: 'Bash' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Continue on error' }));
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'tests', set: { shell: 'bash' } },
      { op: 'updateStep', stepId: 'tests', set: {}, unset: ['continueOnError'] },
    ]);
  });

  it('shows advanced values while collapsed and edits retries', () => {
    const text = REVIEW_LOOP.replace('        run: npm test\n', '        run: npm test\n        timeout: 600\n');
    renderInspector({ doc: docFor(text), selection: 'tests' });
    expect(screen.getByText('Timeout 600 s')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    const retries = screen.getByLabelText('Retries');
    fireEvent.change(retries, { target: { value: '11' } });
    expect(screen.getByText('Use a value from 1 to 10.')).toBeInTheDocument();
    fireEvent.change(retries, { target: { value: '2' } });
    fireEvent.blur(retries);
    expect(sentOps()).toEqual([{ op: 'updateStep', stepId: 'tests', set: { retry: { max: 2 } } }]);
  });

  it('moves the condition when a loop switches from Until to While', () => {
    renderInspector({ selection: 'review_loop' });
    fireEvent.click(screen.getByRole('radio', { name: 'While' }));
    expect(sentOps()).toEqual([
      {
        op: 'updateStep',
        stepId: 'review_loop',
        set: {
          while: {
            all: [
              { value: '${{ steps.tests.exitCode }}', op: 'eq', to: 0 },
              { value: '${{ steps.review.json.approved }}', op: 'isTrue' },
            ],
          },
        },
        unset: ['until'],
      },
    ]);
  });

  it('navigates to the container of a nested block', () => {
    renderInspector({ selection: 'fix' });
    fireEvent.click(screen.getByRole('button', { name: /in Then of/ }));
    expect(screen.getByLabelText('Id')).toHaveValue('needs_fix');
  });

  it('switches a loop to fixed times', () => {
    renderInspector({ selection: 'review_loop' });
    fireEvent.click(screen.getByRole('radio', { name: 'Fixed times' }));
    expect(sentOps()).toEqual([
      { op: 'updateStep', stepId: 'review_loop', set: { onMaxIterations: 'continue' }, unset: ['until', 'while'] },
    ]);
  });

  it('shows diagnostics at their fields and the rest at the top', () => {
    renderInspector({ doc: docFor(REVIEW_LOOP.replace('prompt:', 'promt:')), selection: 'implement' });
    expect(screen.getByText("Unknown property 'promt'")).toBeInTheDocument();
    const task = screen.getByLabelText('Task');
    expect(task).toHaveAttribute('aria-invalid', 'true');
  });

  it('renders blocks of an unknown type without crashing', () => {
    const text = REVIEW_LOOP.replace('    type: agent\n    agent: coder', '    type: agnet');
    renderInspector({ doc: docFor(text), selection: 'implement' });
    expect(screen.getByText("Unknown block type 'agnet'")).toBeInTheDocument();
    expect(screen.getByText('Unknown block', { selector: '.wf-insp-head-type' })).toBeInTheDocument();
  });

  it('copes with fields of the wrong type', () => {
    const text = REVIEW_LOOP.replace('        run: npm test', '        run: [npm, test]\n        env: oops\n        shell: zsh');
    renderInspector({ doc: docFor(text), selection: 'tests' });
    expect(screen.getByLabelText('Command')).toHaveValue('');
    expect(screen.getByLabelText('Shell')).toHaveTextContent('zsh');
  });
});
