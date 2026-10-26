import * as vscode from 'vscode';

const NAMES_KEY = 'isarFlow.secretNames';
const SECRET_PREFIX = 'isarFlow.secret.';
export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_RULE = 'Use letters, digits and underscores, starting with a letter or underscore.';

/** Secrets readable in workflows as `secrets.<name>`: values in SecretStorage, names in global state. */
export class WorkflowSecrets {
  constructor(private readonly context: { secrets: vscode.SecretStorage; globalState: vscode.Memento }) {}

  names(): string[] {
    return [...this.context.globalState.get<string[]>(NAMES_KEY, [])].sort();
  }

  async getAll(): Promise<Record<string, string>> {
    const values: Record<string, string> = {};
    for (const name of this.names()) {
      const value = await this.context.secrets.get(SECRET_PREFIX + name);
      if (value !== undefined) values[name] = value;
    }
    return values;
  }

  async set(name: string, value: string): Promise<void> {
    if (!SECRET_NAME_PATTERN.test(name)) {
      throw new Error(`'${name}' is not a valid secret name. ${NAME_RULE}`);
    }
    await this.context.secrets.store(SECRET_PREFIX + name, value);
    await this.context.globalState.update(NAMES_KEY, [...new Set([...this.names(), name])].sort());
  }

  async delete(name: string): Promise<void> {
    await this.context.secrets.delete(SECRET_PREFIX + name);
    await this.context.globalState.update(
      NAMES_KEY,
      this.names().filter((n) => n !== name),
    );
  }
}

export interface SecretsUi {
  inputBox(options: vscode.InputBoxOptions): Thenable<string | undefined>;
  info(message: string): unknown;
}

const vscodeUi: SecretsUi = {
  inputBox: (options) => vscode.window.showInputBox(options),
  info: (message) => vscode.window.showInformationMessage(message),
};

/** Asks for a secret name (unless given) and its value; an empty value deletes an existing secret. */
export async function setSecretInteractively(
  secrets: WorkflowSecrets,
  ui: SecretsUi = vscodeUi,
  givenName?: string,
): Promise<'saved' | 'deleted' | 'cancelled'> {
  const name =
    givenName !== undefined && SECRET_NAME_PATTERN.test(givenName)
      ? givenName
      : (
          await ui.inputBox({
            title: 'Set workflow secret',
            prompt: 'Name of the secret. Workflows read it as ${{ secrets.NAME }}.',
            placeHolder: 'API_TOKEN',
            ignoreFocusOut: true,
            validateInput: (value) => (SECRET_NAME_PATTERN.test(value.trim()) ? undefined : NAME_RULE),
          })
        )?.trim();
  if (!name) return 'cancelled';

  const exists = secrets.names().includes(name);
  const value = await ui.inputBox({
    title: `Set workflow secret ${name}`,
    prompt: `Value of ${name}. It is kept in VS Code's secret storage.${exists ? ' Leave empty to delete the secret.' : ''}`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v === '' && !exists ? 'Enter a value.' : undefined),
  });
  if (value === undefined) return 'cancelled';

  if (value === '') {
    await secrets.delete(name);
    ui.info(`Deleted secret ${name}.`);
    return 'deleted';
  }
  await secrets.set(name, value);
  ui.info(`Saved secret ${name}. Use it in workflows as \${{ secrets.${name} }}.`);
  return 'saved';
}

/**
 * Registers `isarFlow.setSecret` (optional argument: the secret name). The registration is also added to
 * `context.subscriptions`; disposing the returned Disposable earlier is harmless.
 */
export function registerSecretCommands(
  context: Pick<vscode.ExtensionContext, 'subscriptions'>,
  secrets: WorkflowSecrets,
  ui?: SecretsUi,
): vscode.Disposable {
  const registration = vscode.commands.registerCommand('isarFlow.setSecret', (name?: unknown) =>
    setSecretInteractively(secrets, ui, typeof name === 'string' ? name : undefined),
  );
  context.subscriptions.push(registration);
  return registration;
}
