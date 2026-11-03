import type { ModelPrices, RunRecordSummary, RunReview } from '../protocol';
import type { RunView } from '../run/types';
import type { Workflow } from '../schema/types';

/**
 * full: "Export report" (timeline, statuses, durations and tokens, changed files, agent answers, errors).
 * pr: "Copy for PR description" (a short summary that fits a pull request).
 * chat: the result of Copilot's `isarflow_runWorkflow` tool and of `@isarflow /run` (summary and final outputs).
 */
export type RunReportVariant = 'full' | 'pr' | 'chat';

/** What a run report is built from; everything but `run` is optional. */
export interface RunReportInput {
  run: RunView;
  /** The workflow as it is now: block names, types and document order. Without it blocks use their ids. */
  workflow?: Workflow | null;
  /** Workflow file relative to the workspace folder, forward slashes, for the heading. */
  workflowPath?: string;
  /** The run's history record: review counts ("3 kept, 1 reverted") and `stoppedAt`. */
  record?: RunRecordSummary;
  /** Files the run changed (Package A review) for the diffstat; null or missing = none known. */
  review?: RunReview | null;
  /** Model prices; costs appear only for priced models. */
  prices?: ModelPrices;
}

export interface RunReportOptions {
  /** Default `full`. */
  variant?: RunReportVariant;
  /**
   * Upper bound of the text length. Default: no limit for `full`, 4,000 characters for `pr`, 16,000 for `chat`.
   * Long sections (agent answers, logs, file lists) are shortened first and say so.
   */
  maxChars?: number;
  /** Formats absolute times; default ISO-like UTC "2026-11-03 14:02 UTC" (deterministic for tests). */
  formatTime?: (epochMs: number) => string;
}

/**
 * Builds a Markdown run report (implemented by `runReportMarkdown` in core). Pure: secrets are already masked in
 * run views; simulated and resumed runs are always marked as such.
 */
export type RunReportGenerator = (input: RunReportInput, options?: RunReportOptions) => string;
