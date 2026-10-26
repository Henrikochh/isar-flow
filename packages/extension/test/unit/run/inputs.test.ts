import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { promptForInputs, type InputsUi } from '../../../src/run/inputs';
import { workflowOf } from './fakes';

const WORKFLOW = `version: 1
name: Fix bug
inputs:
  task: { type: string, description: What should be fixed?, required: true }
  attempts: { type: number, description: How many attempts?, default: 3 }
  dryRun: { type: boolean, description: Only show the plan?, default: false }
  note: { description: Optional note }
steps:
  - id: s
    type: approval
    message: ok
`;

function fakeUi(answers: (string | undefined)[], picks: (string | undefined)[] = []) {
  const boxes: vscode.InputBoxOptions[] = [];
  const pickCalls: { items: string[]; options: vscode.QuickPickOptions }[] = [];
  const ui: InputsUi = {
    inputBox: vi.fn(async (options: vscode.InputBoxOptions) => {
      boxes.push(options);
      return answers.shift();
    }),
    quickPick: vi.fn(async (items: string[], options: vscode.QuickPickOptions) => {
      pickCalls.push({ items, options });
      return picks.shift();
    }),
  };
  return { ui, boxes, pickCalls };
}

describe('promptForInputs', () => {
  it('returns {} without asking when the workflow has no inputs', async () => {
    const { ui } = fakeUi([]);
    const wf = workflowOf('version: 1\nname: x\nsteps:\n  - id: a\n    type: approval\n    message: ok\n');
    expect(await promptForInputs(wf, ui)).toEqual({});
    expect(ui.inputBox).not.toHaveBeenCalled();
  });

  it('asks for each input with description as prompt and default as value', async () => {
    const { ui, boxes, pickCalls } = fakeUi(['Fix the login', '5', 'hello'], ['Yes']);
    const values = await promptForInputs(workflowOf(WORKFLOW), ui);
    expect(values).toEqual({ task: 'Fix the login', attempts: 5, dryRun: true, note: 'hello' });

    expect(boxes[0]).toMatchObject({ prompt: 'What should be fixed?', ignoreFocusOut: true });
    expect(boxes[0].title).toContain('Fix bug');
    expect(boxes[1]).toMatchObject({ prompt: 'How many attempts?', value: '3' });
    expect(pickCalls[0].options.placeHolder).toBe('Only show the plan?');
    expect(pickCalls[0].items).toEqual(['No', 'Yes']);
  });

  it('validates required and number inputs', async () => {
    const { ui, boxes } = fakeUi(['task', '2', ''], ['No']);
    await promptForInputs(workflowOf(WORKFLOW), ui);
    const validateTask = boxes[0].validateInput as (v: string) => string | undefined;
    const validateNumber = boxes[1].validateInput as (v: string) => string | undefined;
    expect(validateTask('')).toBe('Enter a value for task.');
    expect(validateTask('x')).toBeUndefined();
    expect(validateNumber('abc')).toBe('Enter a number for attempts.');
    expect(validateNumber(' 4 ')).toBeUndefined();
    expect(validateNumber('')).toBeUndefined();
  });

  it('leaves out optional inputs left empty', async () => {
    const { ui } = fakeUi(['task', '', ''], ['No']);
    expect(await promptForInputs(workflowOf(WORKFLOW), ui)).toEqual({ task: 'task', dryRun: false });
  });

  it('returns undefined when an input box is cancelled', async () => {
    const { ui } = fakeUi(['task', undefined]);
    expect(await promptForInputs(workflowOf(WORKFLOW), ui)).toBeUndefined();
    expect(ui.quickPick).not.toHaveBeenCalled();
  });

  it('returns undefined when the yes/no pick is cancelled', async () => {
    const { ui } = fakeUi(['task', '1'], [undefined]);
    expect(await promptForInputs(workflowOf(WORKFLOW), ui)).toBeUndefined();
  });

  it('offers the default answer first for booleans', async () => {
    const wf = workflowOf(
      'version: 1\nname: x\ninputs:\n  go: { type: boolean, default: true }\nsteps:\n  - id: a\n    type: approval\n    message: ok\n',
    );
    const { ui, pickCalls } = fakeUi([], ['Yes']);
    expect(await promptForInputs(wf, ui)).toEqual({ go: true });
    expect(pickCalls[0].items).toEqual(['Yes', 'No']);
  });
});
