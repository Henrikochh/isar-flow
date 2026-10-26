import * as vscode from 'vscode';
import { isNumberLike, type Workflow, type WorkflowInput } from '@isar-flow/core';

export interface InputsUi {
  inputBox(options: vscode.InputBoxOptions): Thenable<string | undefined>;
  quickPick(items: string[], options: vscode.QuickPickOptions): Thenable<string | undefined>;
}

const vscodeUi: InputsUi = {
  inputBox: (options) => vscode.window.showInputBox(options),
  quickPick: (items, options) => vscode.window.showQuickPick(items, options),
};

const YES = 'Yes';
const NO = 'No';

function validator(name: string, def: WorkflowInput) {
  return (value: string): string | undefined => {
    if (value.trim() === '') return def.required ? `Enter a value for ${name}.` : undefined;
    if (def.type === 'number' && !isNumberLike(value)) return `Enter a number for ${name}.`;
    return undefined;
  };
}

/**
 * Asks for each declared workflow input: input boxes for text and numbers, Yes/No for booleans.
 * Resolves undefined when the user cancels; optional inputs left empty are omitted so their defaults apply.
 */
export async function promptForInputs(
  workflow: Workflow,
  ui: InputsUi = vscodeUi,
): Promise<Record<string, unknown> | undefined> {
  const entries = Object.entries(workflow.inputs ?? {});
  const values: Record<string, unknown> = {};

  for (const [index, [name, def]] of entries.entries()) {
    const counter = entries.length > 1 ? ` (${index + 1}/${entries.length})` : '';
    const title = `Run ${workflow.name}: ${name}${counter}`;

    if (def.type === 'boolean') {
      const items = def.default === true ? [YES, NO] : [NO, YES];
      const choice = await ui.quickPick(items, {
        title,
        placeHolder: def.description ?? name,
        ignoreFocusOut: true,
      });
      if (choice === undefined) return undefined;
      values[name] = choice === YES;
      continue;
    }

    const answer = await ui.inputBox({
      title,
      prompt: def.description ?? `Value for ${name}`,
      placeHolder: name,
      ...(def.default !== undefined && { value: String(def.default) }),
      ignoreFocusOut: true,
      validateInput: validator(name, def),
    });
    if (answer === undefined) return undefined;
    if (answer.trim() === '') continue;
    values[name] = def.type === 'number' ? Number(answer.trim()) : answer;
  }
  return values;
}
