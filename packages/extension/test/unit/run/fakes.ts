import * as vscode from 'vscode';
import { vi } from 'vitest';
import { parseWorkflowText, type SimulationFile, type Workflow } from '@isar-flow/core';
import type { RunTerminal, SimulationStore } from '../../../src/contracts';

export class FakeMemento implements vscode.Memento {
  private readonly data = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.data.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, structuredClone(value));
  }
}

export class FakeSecretStorage implements vscode.SecretStorage {
  readonly values = new Map<string, string>();
  onDidChange = () => ({ dispose: () => undefined });

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export function memoryStore() {
  const files = new Map<string, string>();
  return {
    files,
    read: async (key: string) => files.get(key),
    write: async (key: string, text: string) => void files.set(key, text),
    delete: async (key: string) => void files.delete(key),
  };
}

export class FakeTerminal implements RunTerminal {
  text = '';
  shown = 0;
  disposed = false;
  write(text: string): void {
    this.text += text;
  }
  show(): void {
    this.shown++;
  }
  dispose(): void {
    this.disposed = true;
  }
}

export function workflowOf(yaml: string): Workflow {
  const parsed = parseWorkflowText(yaml);
  if (!parsed.workflow) {
    throw new Error(`Test workflow does not parse: ${JSON.stringify(parsed.diagnostics)}`);
  }
  return parsed.workflow;
}

/** Lets pending promise callbacks (and chained awaits) run. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** A simulation store whose `load` resolves with `mocks`, or rejects when `mocks` is an Error. */
export function fakeSimulations(mocks: SimulationFile | Error = {}) {
  const changes = new vscode.EventEmitter<{ uri: string }>();
  return {
    onDidChange: changes.event,
    uriFor: (_uri: vscode.Uri) => vscode.Uri.file('/ws/.isarflow/simulations/fake.sim.yaml'),
    state: vi.fn(async () => ({
      path: '.isarflow/simulations/fake.sim.yaml',
      exists: true,
      file: mocks instanceof Error ? {} : mocks,
      diagnostics: [],
    })),
    load: vi.fn(async (_uri: vscode.Uri) => {
      if (mocks instanceof Error) throw mocks;
      return mocks;
    }),
    setBlock: vi.fn(async () => undefined),
    renameBlock: vi.fn(async () => undefined),
    open: vi.fn(async (_uri: vscode.Uri) => undefined),
    dispose: vi.fn(),
  } satisfies SimulationStore;
}
