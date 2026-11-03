import * as vscode from 'vscode';
import {
  checkSimulationText,
  newSimulationText,
  parseWorkflowText,
  renameSimulationBlock,
  setSimulationResults,
  type SimulationState,
  type Workflow,
} from '@isar-flow/core';
import type { SimulationStore } from '../contracts';
import { debounce, type Debounced } from '../store/debounce';
import { errorMessage } from '../store/files';
import { baseName, dirName, IGNORE_PATH_CASE, relativeTo } from '../store/paths';
import {
  createVscodeWatcher,
  vscodeSimulationDocuments,
  vscodeSimulationFs,
  type SimulationDocuments,
  type SimulationFs,
  type SimulationWatcher,
} from './simulationIo';
import { isSimulationPath, SIMULATION_GLOB, SIMULATIONS_FOLDER, simulationName } from './simulationPaths';

export interface SimulationStoreDeps {
  fs?: SimulationFs;
  documents?: SimulationDocuments;
  createWatcher?: (glob: string) => SimulationWatcher;
  /** The workspace folder that contains `uri`; undefined outside all folders. */
  workspaceFolder?: (uri: vscode.Uri) => vscode.Uri | undefined;
}

/** Quiet period before a change of one simulation file is reported. */
const CHANGE_DELAY_MS = 150;

const keyOf = (uri: vscode.Uri) => (IGNORE_PATH_CASE ? uri.toString().toLowerCase() : uri.toString());

/**
 * Simulation files of the workflows: `<workspace folder>/.isarflow/simulations/<name>.sim.yaml`. Reads prefer
 * an editor's unsaved text; writes go through an open editor (undoable) or straight to the file.
 */
export function createSimulationStore(deps: SimulationStoreDeps = {}): SimulationStore {
  const fs = deps.fs ?? vscodeSimulationFs;
  const documents = deps.documents ?? vscodeSimulationDocuments;
  const workspaceFolder =
    deps.workspaceFolder ?? ((uri: vscode.Uri) => vscode.workspace.getWorkspaceFolder(uri)?.uri);
  const emitter = new vscode.EventEmitter<{ uri: string }>();
  const pending = new Map<string, Debounced>();
  const queues = new Map<string, Promise<void>>();
  let disposed = false;

  const changed = (uri: vscode.Uri) => {
    if (disposed) return;
    const key = keyOf(uri);
    let report = pending.get(key);
    if (!report) {
      report = debounce(() => {
        pending.delete(key);
        if (!disposed) emitter.fire({ uri: uri.toString() });
      }, CHANGE_DELAY_MS);
      pending.set(key, report);
    }
    report.trigger();
  };

  const watcher = (deps.createWatcher ?? createVscodeWatcher)(SIMULATION_GLOB);
  const subscriptions: vscode.Disposable[] = [
    watcher,
    watcher.onDidCreate(changed),
    watcher.onDidChange(changed),
    watcher.onDidDelete(changed),
    documents.onDidChange((uri) => {
      if (isSimulationPath(uri.path)) changed(uri);
    }),
  ];

  const uriFor = (workflowUri: vscode.Uri): vscode.Uri => {
    const folder = workspaceFolder(workflowUri) ?? workflowUri.with({ path: dirName(workflowUri.path) });
    const name = simulationName(baseName(workflowUri.path));
    const yaml = vscode.Uri.joinPath(folder, ...SIMULATIONS_FOLDER, `${name}.sim.yaml`);
    const yml = vscode.Uri.joinPath(folder, ...SIMULATIONS_FOLDER, `${name}.sim.yml`);
    return !fs.exists(yaml) && fs.exists(yml) ? yml : yaml;
  };

  const displayPath = (workflowUri: vscode.Uri, uri: vscode.Uri) => {
    const folder = workspaceFolder(workflowUri);
    return folder ? relativeTo(folder.path, uri.path, IGNORE_PATH_CASE) : uri.fsPath;
  };

  /** Unsaved edits of an open editor, else the file; undefined when the file does not exist. */
  const currentText = (uri: vscode.Uri): Promise<string | undefined> => {
    const doc = documents.find(uri);
    return doc?.isDirty ? Promise.resolve(doc.getText()) : fs.read(uri);
  };

  const workflowName = async (workflowUri: vscode.Uri): Promise<string> => {
    try {
      const text = documents.find(workflowUri)?.getText() ?? (await fs.read(workflowUri));
      const name: unknown = text === undefined ? undefined : parseWorkflowText(text).workflow?.name;
      if (typeof name === 'string' && name.trim() !== '') return name;
    } catch {
      // The file name below names the file well enough.
    }
    return baseName(workflowUri.path);
  };

  const write = async (uri: vscode.Uri, path: string, text: string) => {
    const doc = documents.find(uri);
    if (!doc) return fs.write(uri, text);
    const wasDirty = doc.isDirty;
    if (!(await documents.replaceAll(uri, text))) {
      throw new Error(`Could not change ${path}. Close its editor and try again.`);
    }
    if (!wasDirty && !(await doc.save())) throw new Error(`Could not save ${path}. Save it in its editor.`);
  };

  /** Changes of one file run one after the other, so quick edits never overwrite each other. */
  const enqueue = (uri: vscode.Uri, task: () => Promise<void>): Promise<void> => {
    const key = keyOf(uri);
    const done = (queues.get(key) ?? Promise.resolve()).then(task);
    const tail = done.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return done;
  };

  /** Applies `change` to the current text (or the template when `create` allows it) and writes the result. */
  const update = (
    workflowUri: vscode.Uri,
    create: boolean,
    change: (text: string) => string,
  ): Promise<void> => {
    const uri = uriFor(workflowUri);
    return enqueue(uri, async () => {
      const current = await currentText(uri);
      if (current === undefined && !create) return;
      const next = change(current ?? newSimulationText(await workflowName(workflowUri)));
      if (next !== current) await write(uri, displayPath(workflowUri, uri), next);
    });
  };

  const state = async (workflowUri: vscode.Uri, workflow: Workflow | null): Promise<SimulationState> => {
    const uri = uriFor(workflowUri);
    const path = displayPath(workflowUri, uri);
    try {
      const text = await currentText(uri);
      if (text === undefined) return { path, exists: false, file: {}, diagnostics: [] };
      return { path, exists: true, ...checkSimulationText(text, workflow) };
    } catch (error) {
      const message = `Could not read ${path}: ${errorMessage(error)}`;
      return {
        path,
        exists: true,
        file: {},
        diagnostics: [{ severity: 'error', code: 'sim-read', message }],
      };
    }
  };

  return {
    onDidChange: emitter.event,
    uriFor,
    state,

    async load(workflowUri) {
      const current = await state(workflowUri, null);
      const error = current.diagnostics.find((d) => d.severity === 'error');
      if (!error) return current.file;
      const line = error.range ? ` (line ${error.range.start.line + 1})` : '';
      throw new Error(`Fix ${current.path} before simulating: ${error.message.replace(/\.$/, '')}${line}.`);
    },

    setBlock(workflowUri, stepId, results) {
      const removes = results === null || results.length === 0;
      return update(workflowUri, !removes, (text) => setSimulationResults(text, stepId, results));
    },

    renameBlock(workflowUri, oldId, newId) {
      return update(workflowUri, false, (text) => renameSimulationBlock(text, oldId, newId));
    },

    async open(workflowUri) {
      const uri = uriFor(workflowUri);
      await enqueue(uri, async () => {
        if (documents.find(uri) || (await fs.read(uri)) !== undefined) return;
        await fs.write(uri, newSimulationText(await workflowName(workflowUri)));
      });
      await documents.show(uri);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const report of pending.values()) report.dispose();
      pending.clear();
      for (const subscription of subscriptions.splice(0)) subscription.dispose();
      emitter.dispose();
    },
  };
}
