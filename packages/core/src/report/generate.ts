import type { RunView } from '../run/types';
import { reportBlocks } from './blocks';
import { CHAT_LIMITS, CHAT_MAX_CHARS, chatReport } from './chat';
import { type ReportContext, workflowName } from './facts';
import { fitReport } from './fit';
import { formatUtcTime } from './format';
import { FULL_LIMITS, fullReport } from './full';
import { PR_LIMITS, PR_MAX_CHARS, prReport } from './pr';
import type { RunReportGenerator } from './types';

/**
 * A Markdown run report: `full` ("Export report"), `pr` ("Copy for PR description", at most 4,000 characters by
 * default) or `chat` (Copilot tool results and `@isarflow /run`, at most 16,000). Pure apart from the time in the
 * footer of `full`; run views are already masked, so nothing here unmasks values.
 */
export const runReportMarkdown: RunReportGenerator = (input, options = {}) => {
  const ctx: ReportContext = {
    input,
    run: input.run,
    name: workflowName(input),
    blocks: reportBlocks(input.run, input.workflow),
    formatTime: options.formatTime ?? formatUtcTime,
  };
  switch (options.variant) {
    case 'pr':
      return fitReport((limits) => prReport(ctx, limits), PR_LIMITS, options.maxChars ?? PR_MAX_CHARS);
    case 'chat':
      return fitReport((limits) => chatReport(ctx, limits), CHAT_LIMITS, options.maxChars ?? CHAT_MAX_CHARS);
    default: {
      const generatedAt = Date.now();
      return fitReport((limits) => fullReport(ctx, limits, generatedAt), FULL_LIMITS, options.maxChars);
    }
  }
};

const pad = (value: number) => String(value).padStart(2, '0');

/** `<workflow-name-slug>-run-<YYYY-MM-DD-HHmm>.md` with the local start time of the run. */
export function runReportFileName(run: Pick<RunView, 'workflowName' | 'startedAt'>): string {
  const slug =
    (run.workflowName ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'workflow';
  const date = new Date(run.startedAt);
  const stamp = Number.isNaN(date.getTime())
    ? 'unknown'
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-` +
      `${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${slug}-run-${stamp}.md`;
}
