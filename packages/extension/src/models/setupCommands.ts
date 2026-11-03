import * as vscode from 'vscode';
import type { ChatModelInfo, ModelCatalog, ModelProbeResult, SetupReport } from '@isar-flow/core';
import type { AgentStore, ModelRegistry, SetupCheck } from '../contracts';
import { vscodeCommandUi } from './commands';
import type { CommandUi } from './providerCommands';
import { isRecord } from './settings';
import { fixCommand, probeFix } from './setupItems';

/** The dialogs of "Test model" and "Check setup". */
export interface SetupCommandUi extends Pick<CommandUi, 'pick' | 'info' | 'error' | 'progress'> {
  warn(message: string, ...actions: string[]): Promise<string | undefined>;
}

export interface SetupCommandDeps {
  registry: Pick<ModelRegistry, 'catalog' | 'probe'>;
  setupCheck: Pick<SetupCheck, 'run' | 'current'>;
  /** Model references the agents use; listed first when the user picks a model. */
  usedModels(): string[];
  ui: SetupCommandUi;
  isTrusted(): boolean;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
}

export interface SetupCommands {
  /** Argument: a model reference, `{ ref }`, or `{ providerId }` to pick among that endpoint's models. */
  testModel(arg?: unknown): Promise<void>;
  /** `{ quiet: true }` (the sidebar, which shows the report itself) skips revealing it and the notification. */
  checkSetup(arg?: unknown): Promise<void>;
}

type PickItem = vscode.QuickPickItem & { ref?: string };

/** vscode.QuickPickItemKind.Separator, written as its value so the module works without the enum. */
const SEPARATOR = -1 as vscode.QuickPickItemKind;
const SIDEBAR = 'workbench.view.extension.isarFlow';
const ADD = 'Add model endpoint';

/** Reads the argument of isarFlow.testModel; anything else (e.g. a menu's URI) means "let the user pick". */
export function testModelArg(arg: unknown): { ref?: string; providerId?: string } {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  if (typeof arg === 'string') return text(arg) ? { ref: text(arg) } : {};
  if (!isRecord(arg)) return {};
  const ref = text(arg.ref);
  if (ref) return { ref };
  const providerId = text(arg.providerId);
  return providerId ? { providerId } : {};
}

export function createSetupCommands(deps: SetupCommandDeps): SetupCommands {
  const { registry, ui } = deps;

  const run = (command: [string, ...unknown[]] | undefined) => {
    if (command) void deps.executeCommand(...command);
  };

  function item(ref: string, info: ChatModelInfo | undefined, catalog: ModelCatalog): PickItem {
    const tested = catalog.probes?.[ref];
    return {
      label: info?.name ?? ref,
      description: ref,
      ...(tested ? { detail: `Last test: ${tested.message}` } : {}),
      ref,
    };
  }

  /** Used models first, then the others grouped by endpoint. */
  function pickItems(catalog: ModelCatalog, models: ChatModelInfo[], used: string[]): PickItem[] {
    const byRef = new Map(catalog.models.map((m) => [m.ref, m]));
    const items: PickItem[] = [];
    if (used.length) {
      items.push({ label: 'Used by your agents', kind: SEPARATOR });
      for (const ref of used) items.push(item(ref, byRef.get(ref), catalog));
    }
    const done = new Set(used);
    for (const provider of catalog.providers) {
      const rest = models.filter((m) => m.provider === provider.id && !done.has(m.ref));
      if (!rest.length) continue;
      items.push({ label: provider.label, kind: SEPARATOR });
      for (const m of rest) items.push(item(m.ref, m, catalog));
    }
    return items;
  }

  async function pickModel(providerId: string | undefined): Promise<string | undefined> {
    const catalog = registry.catalog();
    let models = catalog.models;
    let used = deps.usedModels();
    if (providerId !== undefined) {
      const provider = catalog.providers.find((p) => p.id === providerId);
      if (!provider) {
        void ui.error(`There is no model endpoint '${providerId}'.`);
        return undefined;
      }
      models = models.filter((m) => m.provider === providerId);
      used = used.filter((ref) => ref.startsWith(`${providerId}/`));
      if (!models.length && !used.length) {
        void ui.info(`${provider.label} lists no models to test.`);
        return undefined;
      }
    } else if (!models.length && !used.length) {
      void ui.info('There are no models to test yet.', ADD).then((choice) => {
        if (choice === ADD) run(['isarFlow.addProvider']);
      });
      return undefined;
    }
    const picked = await ui.pick(pickItems(catalog, models, used), {
      title: 'Test model',
      placeHolder: 'Which model should make a tool call and a JSON answer?',
    });
    return picked?.ref;
  }

  function report(ref: string, result: ModelProbeResult): void {
    switch (result.outcome) {
      case 'tools': {
        const latency = result.latencyMs === undefined ? '' : ` (${(result.latencyMs / 1000).toFixed(1)} s)`;
        void ui.info(`${ref}: ${result.message}${latency}.`);
        return;
      }
      case 'text':
        void ui.warn(
          `${ref}: Needs text tool mode. In the agents that use it, set Tool calls to Text in the prompt.`,
        );
        return;
      default: {
        const fix = probeFix(ref, result, registry.catalog());
        const command = fix && fixCommand(fix.message);
        const actions = fix && command ? [fix.label] : [];
        // Not awaited: a notification stays open until the user closes it.
        void ui.error(`${ref}: ${result.message}`, ...actions).then((choice) => {
          if (fix && choice === fix.label) run(command);
        });
      }
    }
  }

  function summarize(report: SetupReport): void {
    const problems = report.items.filter((i) => i.status === 'error' || i.status === 'warning').length;
    if (!problems) {
      void ui.info('Setup check passed.');
      return;
    }
    void ui
      .warn(`Setup check found ${problems} problem${problems === 1 ? '' : 's'}.`, 'Show')
      .then((choice) => {
        if (choice === 'Show') run([SIDEBAR]);
      });
  }

  return {
    async testModel(arg) {
      if (!deps.isTrusted()) {
        void ui.error('Trust this workspace to test models.');
        return;
      }
      const { probe } = registry;
      if (!probe) return;
      const given = testModelArg(arg);
      const ref = given.ref ?? (await pickModel(given.providerId));
      if (!ref) return;
      const outcome = await ui.progress(
        `Testing ${ref}…`,
        async (signal) => ({ result: await probe.call(registry, ref, signal), cancelled: signal.aborted }),
        { cancellable: true },
      );
      if (!outcome.cancelled) report(ref, outcome.result);
    },

    async checkSetup(arg) {
      if (!deps.isTrusted()) {
        void ui.error('Trust this workspace to check the setup.');
        return;
      }
      const quiet = isRecord(arg) && arg.quiet === true;
      const running = deps.setupCheck.run();
      if (!quiet) run([SIDEBAR]);
      const finished = await running;
      // Dismissed meanwhile, or replaced by a newer check: the sidebar shows what is current.
      if (!quiet && deps.setupCheck.current() === finished) summarize(finished);
    },
  };
}

export interface RegisterSetupCommandsDeps {
  registry: Pick<ModelRegistry, 'catalog' | 'probe'>;
  setupCheck: Pick<SetupCheck, 'run' | 'current'>;
  agents: Pick<AgentStore, 'list' | 'definitions'>;
  ui?: SetupCommandUi;
}

/** Registers isarFlow.testModel and isarFlow.checkSetup. */
export function registerSetupCommands(deps: RegisterSetupCommandsDeps): vscode.Disposable {
  const commands = createSetupCommands({
    registry: deps.registry,
    setupCheck: deps.setupCheck,
    usedModels: () => agentModels(deps.agents),
    ui: deps.ui ?? vscodeSetupUi(),
    isTrusted: () => vscode.workspace.isTrusted,
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  });
  const register = (id: string, handler: (arg: unknown) => Promise<void>) =>
    vscode.commands.registerCommand(id, async (arg?: unknown) => {
      try {
        await handler(arg);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    });
  return vscode.Disposable.from(
    register('isarFlow.testModel', (arg) => commands.testModel(arg)),
    register('isarFlow.checkSetup', (arg) => commands.checkSetup(arg)),
  );
}

/** The models and fallback models of the agent files, without templates. */
export function agentModels(agents: Pick<AgentStore, 'list' | 'definitions'>): string[] {
  const refs = new Set<string>();
  const add = (ref: unknown) => {
    if (typeof ref === 'string' && ref.trim() && !ref.includes('${{')) refs.add(ref.trim());
  };
  for (const agent of agents.list()) if (!agent.shadowed) add(agent.model);
  for (const definition of Object.values(agents.definitions())) {
    if (Array.isArray(definition.fallbackModels)) definition.fallbackModels.forEach(add);
  }
  return [...refs].sort();
}

export function vscodeSetupUi(): SetupCommandUi {
  return {
    ...vscodeCommandUi(),
    warn: async (message, ...actions) => vscode.window.showWarningMessage(message, ...actions),
  };
}
