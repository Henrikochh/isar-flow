import * as vscode from 'vscode';
import { type ModelCatalog, parseWorkflowText, type SetupCheckItem, type SetupReport } from '@isar-flow/core';
import type { AgentStore, ModelRegistry, SetupCheck, WorkflowStore } from '../contracts';
import { modelUsage, type ModelUse, type UsageWorkflow } from './modelUsage';
import { endpointItems, modelItem, testingItem, untestedModelItem } from './setupItems';

export interface SetupCheckDeps {
  models: Pick<ModelRegistry, 'refresh' | 'catalog' | 'probe'>;
  workflows: Pick<WorkflowStore, 'list'>;
  agents: Pick<AgentStore, 'list' | 'definitions'>;
  log: Pick<vscode.LogOutputChannel, 'info' | 'warn'>;
  /** Reads a workflow file by URI; default: the open editor's text, else the file on disk. */
  readText?: (uri: string) => Promise<string>;
  now?: () => number;
  /** How long endpoints get to list their models before the check goes on without them (default 30 s). */
  refreshTimeoutMs?: number;
}

const REFRESH_TIMEOUT_MS = 30_000;

const NO_MODELS: SetupCheckItem = {
  id: 'model:none',
  kind: 'model',
  label: 'Models',
  status: 'skipped',
  message: 'No workflow uses a model yet.',
};

export function createSetupCheck(deps: SetupCheckDeps): SetupCheck & vscode.Disposable {
  return new SetupChecker(deps);
}

/** The unsaved text of an open editor, else the file on disk. */
export async function readWorkflowText(uri: string): Promise<string> {
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri);
  if (open) return open.getText();
  return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(uri)));
}

class SetupChecker implements SetupCheck, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly now: () => number;
  private report: SetupReport | undefined;
  private running: { promise: Promise<SetupReport>; controller: AbortController } | undefined;

  constructor(private readonly deps: SetupCheckDeps) {
    this.now = deps.now ?? Date.now;
  }

  current(): SetupReport | undefined {
    return this.report;
  }

  run(): Promise<SetupReport> {
    if (this.running) return this.running.promise;
    const controller = new AbortController();
    const promise: Promise<SetupReport> = this.check(controller.signal).finally(() => {
      if (this.running?.promise === promise) this.running = undefined;
    });
    this.running = { promise, controller };
    return promise;
  }

  dismiss(): void {
    const running = this.running;
    this.running = undefined;
    running?.controller.abort();
    if (this.report === undefined) return;
    this.report = undefined;
    this.emitter.fire();
  }

  dispose(): void {
    this.running?.controller.abort();
    this.running = undefined;
    this.emitter.dispose();
  }

  private async check(signal: AbortSignal): Promise<SetupReport> {
    const startedAt = this.now();
    let items: SetupCheckItem[] = [];
    // Every change publishes a new report object, so listeners can compare reports by reference.
    const publish = (finished = false): SetupReport => {
      const report: SetupReport = { startedAt, items: [...items] };
      if (finished) report.finishedAt = this.now();
      if (!signal.aborted) {
        this.report = report;
        this.emitter.fire();
      }
      return report;
    };
    const finish = (): SetupReport => {
      items = items.map((item) =>
        item.status === 'running' ? { ...item, status: 'skipped', message: 'Not tested.' } : item,
      );
      const report = publish(true);
      const problems = items.filter((i) => i.status === 'error' || i.status === 'warning').length;
      this.deps.log.info(`Setup check finished: ${problems} problem${problems === 1 ? '' : 's'}.`);
      return report;
    };

    publish();
    const catalog = await this.refreshCatalog();
    if (signal.aborted) return finish();
    items = endpointItems(catalog);
    publish();

    const uses = await this.modelUses();
    if (signal.aborted) return finish();
    if (!uses.length) items.push(NO_MODELS);
    for (const use of uses) {
      if (signal.aborted) break;
      const untested = untestedModelItem(use, catalog);
      if (untested) {
        items.push(untested);
        continue;
      }
      items.push(testingItem(use));
      publish();
      const item = await this.test(use, catalog, signal);
      if (signal.aborted) break;
      items[items.length - 1] = item;
      publish();
    }
    return finish();
  }

  private async test(use: ModelUse, catalog: ModelCatalog, signal: AbortSignal): Promise<SetupCheckItem> {
    const { probe } = this.deps.models;
    if (!probe) return { ...testingItem(use), status: 'skipped', message: 'Not tested.' };
    return modelItem(use, await probe.call(this.deps.models, use.ref, signal), catalog);
  }

  /** Lists the models again; endpoints that do not answer in time are reported with the catalog as it is. */
  private async refreshCatalog(): Promise<ModelCatalog> {
    const { models, log } = this.deps;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ModelCatalog>((resolve) => {
      timer = setTimeout(() => resolve(models.catalog()), this.deps.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS);
    });
    try {
      return await Promise.race([models.refresh(), timeout]);
    } catch (error) {
      log.warn(`Setup check: refreshing the models failed: ${messageOf(error)}`);
      return models.catalog();
    } finally {
      clearTimeout(timer);
    }
  }

  private async modelUses(): Promise<ModelUse[]> {
    const { workflows, agents, log } = this.deps;
    const read = this.deps.readText ?? readWorkflowText;
    const files = await Promise.all(
      workflows.list().map(async (summary): Promise<UsageWorkflow | undefined> => {
        try {
          const { workflow } = parseWorkflowText(await read(summary.uri));
          if (workflow) {
            const { uri, name, relativePath } = summary;
            return { uri, name, relativePath, workflow };
          }
          log.warn(`Setup check skipped ${summary.relativePath}: it can't be read as a workflow.`);
        } catch (error) {
          log.warn(`Setup check could not read ${summary.relativePath}: ${messageOf(error)}`);
        }
        return undefined;
      }),
    );
    return modelUsage(
      files.filter((file): file is UsageWorkflow => file !== undefined),
      agents.list(),
      agents.definitions(),
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
