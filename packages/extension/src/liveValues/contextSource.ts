import { type LiveContext, liveContext, type RunView } from '@isar-flow/core';
import type { RunManager } from '../contracts';

/** The run context live values of a workflow come from; undefined when the workflow has no readable run. */
export type LiveContextSource = (workflowUri: string) => Promise<LiveContext | undefined>;

/** Contexts kept, the least recently used dropped first (a few workflows with a live and a saved run each). */
const MAX_CACHED = 16;

interface Entry {
  /** Set for running runs: their view changes with every event. */
  view?: RunView;
  context: LiveContext;
}

/**
 * Live values come from the running run of the workflow, else from its newest saved run. Contexts are cached per
 * run id and status; a running run's view changes with every event, so its context is also tied to that view.
 */
export function createLiveContextSource(runs: Pick<RunManager, 'active' | 'history'>): LiveContextSource {
  const cache = new Map<string, Entry>();
  const use = (key: string, entry: Entry): LiveContext => {
    cache.delete(key);
    cache.set(key, entry);
    const oldest = cache.keys().next().value;
    if (cache.size > MAX_CACHED && oldest !== undefined) cache.delete(oldest);
    return entry.context;
  };

  return async (workflowUri) => {
    const live = runs.active(workflowUri)[0];
    if (live) {
      const key = `${live.runId}\n${live.view.status}`;
      const cached = cache.get(key);
      const reusable = cached?.view === live.view ? cached : undefined;
      return use(key, reusable ?? { view: live.view, context: liveContext(live.view) });
    }
    const newest = runs.history.list(workflowUri)[0];
    if (!newest) return undefined;
    const key = `${newest.runId}\n${newest.status}`;
    const cached = cache.get(key);
    if (cached && !cached.view) return use(key, cached);
    const view =
      runs.history.get(newest.runId) ?? (await runs.history.getAsync(newest.runId).catch(() => undefined));
    return view ? use(key, { context: liveContext(view) }) : undefined;
  };
}
