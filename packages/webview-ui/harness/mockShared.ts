/** Pieces the mock hosts share: the scripted-check probe, timing helpers and the fake "Test model". */
import type { ModelCatalog, ModelProbeResult } from '@isar-flow/core';

export type Send<T> = (message: T) => void;

/** What the mock hosts hold, for scripted checks (scripts/interactions.mjs reads it as window.__harness.probe). */
export const probe: {
  workflowText?: () => string;
  agentText?: () => string;
  /** Diffs the workflow editor asked to open, oldest first. */
  openedDiffs?: () => { runId: string; path: string }[];
  /** Text of the workflow's simulation file. */
  simulationText?: () => string;
  /** How often the workflow editor asked to open the simulation file. */
  openedSimulation?: () => number;
  /** Answers the workflow editor sent to ask blocks, oldest first. */
  answers?: () => { requestId: string; answer: string }[];
  /** Export report / Copy for PR description requests, oldest first. */
  reports?: () => { runId: string; action: string }[];
  /** Settings the webviews asked to open (the search query), oldest first. */
  settingsQueries?: () => string[];
  /** How often the workflow editor asked to resume paused triggers. */
  resumedTriggers?: () => number;
  /** Memory files the agent editor or the sidebar asked to open: the folder URI, or null for "this agent's". */
  openedMemory?: () => (string | null)[];
} = {};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function markReady(): void {
  setTimeout(() => {
    document.body.dataset.harnessReady = 'true';
  }, 250);
}

/** The fake probe result: models whose ref names llama or qwen need text tool mode, the rest call tools. */
export function fakeProbe(ref: string, testedAt = Date.now()): ModelProbeResult {
  const text = /llama|qwen/i.test(ref);
  return {
    ref,
    outcome: text ? 'text' : 'tools',
    message: text ? 'Needs text tool mode' : 'Tool calls work',
    toolCalls: !text,
    json: true,
    latencyMs: text ? 2_350 : 820,
    testedAt,
  };
}

/** Runs "Test model" on a catalog: the ref is probing at once and gets its result after 600 ms. */
export function testModel(
  ref: string,
  catalog: () => ModelCatalog,
  update: (catalog: ModelCatalog) => void,
): void {
  const current = catalog();
  update({ ...current, probing: [...(current.probing ?? []).filter((r) => r !== ref), ref] });
  setTimeout(() => {
    const latest = catalog();
    update({
      ...latest,
      probing: (latest.probing ?? []).filter((r) => r !== ref),
      probes: { ...latest.probes, [ref]: fakeProbe(ref) },
    });
  }, 600);
}
