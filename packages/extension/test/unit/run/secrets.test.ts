import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { setSecretInteractively, WorkflowSecrets, type SecretsUi } from '../../../src/run/secrets';
import { FakeMemento, FakeSecretStorage } from './fakes';

function secrets() {
  const context = { secrets: new FakeSecretStorage(), globalState: new FakeMemento() };
  return { context, store: new WorkflowSecrets(context) };
}

describe('WorkflowSecrets', () => {
  it('stores values in SecretStorage and names in global state', async () => {
    const { context, store } = secrets();
    await store.set('TOKEN', 's3cret');
    await store.set('API_KEY', 'k');
    expect(store.names()).toEqual(['API_KEY', 'TOKEN']);
    expect(context.secrets.values.get('isarFlow.secret.TOKEN')).toBe('s3cret');
    expect(await store.getAll()).toEqual({ API_KEY: 'k', TOKEN: 's3cret' });
    expect(new WorkflowSecrets(context).names()).toEqual(['API_KEY', 'TOKEN']);
  });

  it('deletes values and names', async () => {
    const { context, store } = secrets();
    await store.set('TOKEN', 'x');
    await store.delete('TOKEN');
    expect(store.names()).toEqual([]);
    expect(context.secrets.values.size).toBe(0);
  });

  it('rejects invalid names', async () => {
    const { store } = secrets();
    await expect(store.set('1bad', 'x')).rejects.toThrow(/letters, digits and underscores/);
    await expect(store.set('has-dash', 'x')).rejects.toThrow();
  });

  it('skips names whose value is gone', async () => {
    const { context, store } = secrets();
    await store.set('A', '1');
    context.secrets.values.clear();
    expect(await store.getAll()).toEqual({});
  });
});

describe('setSecretInteractively', () => {
  function fakeUi(answers: (string | undefined)[]) {
    const boxes: vscode.InputBoxOptions[] = [];
    const ui: SecretsUi = {
      inputBox: async (options) => {
        boxes.push(options);
        return answers.shift();
      },
      info: vi.fn(),
    };
    return { ui, boxes };
  }

  it('asks for a validated name, then for the value as a password', async () => {
    const { store } = secrets();
    const { ui, boxes } = fakeUi(['GITHUB_TOKEN', 'ghp_x']);
    expect(await setSecretInteractively(store, ui)).toBe('saved');
    expect(await store.getAll()).toEqual({ GITHUB_TOKEN: 'ghp_x' });
    const validateName = boxes[0].validateInput as (v: string) => string | undefined;
    expect(validateName('ok_name')).toBeUndefined();
    expect(validateName('9lives')).toMatch(/letters, digits and underscores/);
    expect(boxes[1].password).toBe(true);
    expect(ui.info).toHaveBeenCalledWith(expect.stringContaining('GITHUB_TOKEN'));
  });

  it('uses a name passed as argument', async () => {
    const { store } = secrets();
    const { ui, boxes } = fakeUi(['v']);
    expect(await setSecretInteractively(store, ui, 'GIVEN')).toBe('saved');
    expect(boxes).toHaveLength(1);
    expect(store.names()).toEqual(['GIVEN']);
  });

  it('deletes an existing secret when the value is left empty', async () => {
    const { store } = secrets();
    await store.set('OLD', 'x');
    const { ui } = fakeUi(['OLD', '']);
    expect(await setSecretInteractively(store, ui)).toBe('deleted');
    expect(store.names()).toEqual([]);
  });

  it('does nothing when cancelled', async () => {
    const { store } = secrets();
    expect(await setSecretInteractively(store, fakeUi([undefined]).ui)).toBe('cancelled');
    expect(await setSecretInteractively(store, fakeUi(['A', undefined]).ui)).toBe('cancelled');
    expect(store.names()).toEqual([]);
  });
});
