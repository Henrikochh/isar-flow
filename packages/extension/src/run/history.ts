import * as vscode from 'vscode';
import {
  runRecordSummary,
  type ReviewCounts,
  type RunRecordSummary,
  type RunView,
  type StepRunView,
} from '@isar-flow/core';
import type { RunHistory } from '../contracts';

/** Upper bound for one saved run (JSON, UTF-8). */
export const MAX_RUN_BYTES = 1024 * 1024;
const INDEX_KEY = 'isarFlow.runHistory';
/** Views kept in memory for synchronous `get`. */
const CACHE_SIZE = 60;
const DEFAULT_LIMIT = 50;
const MAX_DEPTH = 40;

/** Progressively stricter limits, tried in order until the run fits into MAX_RUN_BYTES. */
const TRIM_LEVELS = [
  { logs: 300, chars: 100_000 },
  { logs: 100, chars: 20_000 },
  { logs: 30, chars: 4_000 },
  { logs: 10, chars: 1_000 },
  { logs: 0, chars: 200 },
];

/** Key/value text storage for saved runs (one entry per run id). */
export interface HistoryStore {
  read(key: string): Promise<string | undefined>;
  write(key: string, text: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface FileRunHistory extends RunHistory, vscode.Disposable {
  setReview(runId: string, counts: ReviewCounts): Promise<void>;
  readonly onDidRemove: vscode.Event<{ workflowUri: string; runIds: string[] }>;
  /** Loads the newest saved runs into the cache so `get` can answer synchronously. */
  loadAll(workflowUri?: string): Promise<void>;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated: ${text.length - max} more characters were not saved]`;
}

/** `cut.done` turns true when a string was shortened or a nested part was dropped. */
function trimValue(
  value: unknown,
  max: number,
  cut: { done: boolean } = { done: false },
  depth = 0,
): unknown {
  if (typeof value === 'string') {
    if (value.length > max) cut.done = true;
    return truncate(value, max);
  }
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_DEPTH) {
    cut.done = true;
    return '[nested too deeply to save]';
  }
  if (Array.isArray(value)) return value.map((item) => trimValue(item, max, cut, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = trimValue(item, max, cut, depth + 1);
  return out;
}

function trimStep(step: StepRunView, level: { logs: number; chars: number }): StepRunView {
  const dropped = step.logs.length > level.logs;
  const logs = (dropped ? step.logs.slice(step.logs.length - level.logs) : step.logs).map((line) => ({
    stream: line.stream,
    text: truncate(line.text, level.chars),
  }));
  const cut = { done: false };
  const output = step.output === undefined ? undefined : trimValue(step.output, level.chars, cut);
  return {
    ...step,
    ...(step.detail !== undefined && { detail: truncate(step.detail, level.chars) }),
    ...(step.error !== undefined && { error: truncate(step.error, level.chars) }),
    ...(output !== undefined && { output: output as StepRunView['output'] }),
    ...(cut.done && { outputTrimmed: true }),
    logs,
    ...(dropped && { logsTruncated: true }),
  };
}

function trimAt(view: RunView, level: { logs: number; chars: number }): RunView {
  const steps: Record<string, StepRunView> = {};
  for (const [id, step] of Object.entries(view.steps)) steps[id] = trimStep(step, level);
  return {
    ...view,
    ...(view.error !== undefined && { error: truncate(view.error, level.chars) }),
    inputs: trimValue(view.inputs, level.chars) as Record<string, unknown>,
    steps,
  };
}

/**
 * Last resort: statuses, errors, metrics and what Run from here and the run summary read (start time, loop
 * position, reused). Outputs are dropped and marked as trimmed.
 */
function skeleton(view: RunView): RunView {
  const steps: Record<string, StepRunView> = {};
  for (const [id, step] of Object.entries(view.steps)) {
    steps[id] = {
      status: step.status,
      executions: step.executions,
      ...(step.startedAt !== undefined && { startedAt: step.startedAt }),
      ...(step.iteration !== undefined && { iteration: step.iteration }),
      ...(step.loop !== undefined && { loop: step.loop }),
      ...(step.durationMs !== undefined && { durationMs: step.durationMs }),
      ...(step.error !== undefined && { error: truncate(step.error, 200) }),
      ...(step.metrics !== undefined && { metrics: step.metrics }),
      ...(step.reused && { reused: true }),
      ...((step.outputTrimmed || step.output !== undefined) && { outputTrimmed: true }),
      logs: [],
      ...(step.logs.length > 0 && { logsTruncated: true }),
    };
  }
  return { ...view, inputs: {}, steps };
}

const sizeOf = (view: RunView) => Buffer.byteLength(JSON.stringify(view), 'utf8');

/** Shrinks a run for storage: ≤ 300 log entries per block, strings ≤ 100 KB, whole run ≤ 1 MB. */
export function trimRunView(view: RunView): RunView {
  for (const level of TRIM_LEVELS) {
    const trimmed = trimAt(view, level);
    if (sizeOf(trimmed) <= MAX_RUN_BYTES) return trimmed;
  }
  return skeleton(view);
}

const newestFirst = (a: RunRecordSummary, b: RunRecordSummary) => b.startedAt - a.startedAt;

function isSummary(value: unknown): value is RunRecordSummary {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.runId === 'string' &&
    typeof record.workflowUri === 'string' &&
    typeof record.startedAt === 'number'
  );
}

function parseView(text: string | undefined, runId: string): RunView | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const view = value as RunView;
    return view.runId === runId && typeof view.steps === 'object' && view.steps !== null ? view : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run history: trimmed RunViews as JSON in `store` (key = run id), summaries in the `index` memento.
 * `limit` is read on every save and applies per workflow, to real and to simulated runs separately.
 */
export function createRunHistory(
  store: HistoryStore,
  index: vscode.Memento,
  limit: () => number,
): FileRunHistory {
  const onDidChange = new vscode.EventEmitter<void>();
  const onDidRemove = new vscode.EventEmitter<{ workflowUri: string; runIds: string[] }>();
  const stored = index.get<unknown[]>(INDEX_KEY, []);
  let records: RunRecordSummary[] = (Array.isArray(stored) ? stored : []).filter(isSummary).sort(newestFirst);
  const cache = new Map<string, RunView>();
  let queue: Promise<void> = Promise.resolve();

  const remember = (view: RunView) => {
    cache.delete(view.runId);
    cache.set(view.runId, view);
    for (const oldest of cache.keys()) {
      if (cache.size <= CACHE_SIZE) break;
      cache.delete(oldest);
    }
  };

  const maxPerWorkflow = () => {
    const value = Math.floor(limit());
    return Number.isFinite(value) ? Math.max(1, value) : DEFAULT_LIMIT;
  };

  async function persist(view: RunView, workflowUri: string): Promise<void> {
    const trimmed = trimRunView(view);
    await store.write(view.runId, JSON.stringify(trimmed));
    remember(trimmed);

    const previous = records.find((r) => r.runId === view.runId);
    const summary: RunRecordSummary = {
      ...runRecordSummary(trimmed, workflowUri),
      ...(previous?.review && { review: previous.review }),
    };
    const sorted = [summary, ...records.filter((r) => r.runId !== view.runId)].sort(newestFirst);
    const max = maxPerWorkflow();
    // Real and simulated runs are limited separately: a simulation never pushes out a real run and its review.
    const simulated = summary.simulated === true;
    const removed: string[] = [];
    let kept = 0;
    records = sorted.filter((record) => {
      if (record.workflowUri !== workflowUri || (record.simulated === true) !== simulated) return true;
      if (++kept <= max) return true;
      removed.push(record.runId);
      return false;
    });
    await index.update(INDEX_KEY, records);
    for (const runId of removed) {
      cache.delete(runId);
      await store.delete(runId).catch(() => undefined);
    }
    onDidChange.fire();
    if (removed.length > 0) onDidRemove.fire({ workflowUri, runIds: removed });
  }

  async function storeReview(runId: string, counts: ReviewCounts): Promise<void> {
    if (!records.some((r) => r.runId === runId)) return;
    records = records.map((r) => (r.runId === runId ? { ...r, review: { ...counts } } : r));
    await index.update(INDEX_KEY, records);
    onDidChange.fire();
  }

  /** Index changes run one after the other, so concurrent saves and reviews never lose an entry. */
  function enqueue(task: () => Promise<void>): Promise<void> {
    const done = queue.then(task);
    queue = done.catch(() => undefined);
    return done;
  }

  const getAsync = async (runId: string): Promise<RunView | undefined> => {
    const cached = cache.get(runId);
    if (cached) return cached;
    if (!records.some((r) => r.runId === runId)) return undefined;
    const view = parseView(await store.read(runId).catch(() => undefined), runId);
    if (view) remember(view);
    return view;
  };

  return {
    onDidChange: onDidChange.event,
    onDidRemove: onDidRemove.event,
    list: (workflowUri) => records.filter((r) => workflowUri === undefined || r.workflowUri === workflowUri),
    get: (runId) => cache.get(runId),
    getAsync,
    async loadAll(workflowUri) {
      const wanted = records.filter((r) => workflowUri === undefined || r.workflowUri === workflowUri);
      for (const record of wanted.slice(0, CACHE_SIZE)) await getAsync(record.runId);
    },
    save: (view, workflowUri) => enqueue(() => persist(view, workflowUri)),
    setReview: (runId, counts) => enqueue(() => storeReview(runId, counts)),
    dispose: () => {
      onDidChange.dispose();
      onDidRemove.dispose();
    },
  };
}

/** Stores runs as `runs/<runId>.json` under the extension's (workspace) storage folder. */
export function createFileHistoryStore(storageUri: vscode.Uri): HistoryStore {
  const folder = vscode.Uri.joinPath(storageUri, 'runs');
  const fileOf = (key: string) => vscode.Uri.joinPath(folder, `${key.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  return {
    async read(key) {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(fileOf(key)));
      } catch {
        return undefined;
      }
    },
    async write(key, text) {
      await vscode.workspace.fs.createDirectory(folder);
      await vscode.workspace.fs.writeFile(fileOf(key), new TextEncoder().encode(text));
    },
    async delete(key) {
      try {
        await vscode.workspace.fs.delete(fileOf(key));
      } catch {
        // Already gone.
      }
    },
  };
}
