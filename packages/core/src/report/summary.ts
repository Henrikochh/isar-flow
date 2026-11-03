import { type BlockState, type ReportBlock } from './blocks';
import { changesText, errorOf, type ReportContext, reviewSummary, stoppedAt } from './facts';
import { code, cutChars, escapeText, formatDuration, formatNumber, oneLine, plural } from './format';

const ERROR_MAX_CHARS = 300;

/**
 * What happened to the run, after its name: "succeeded in 4m 12s", "failed at tests: <error>", "cancelled at
 * tests", "running". As a sentence: "was cancelled at tests", "is still running".
 */
export function statusPhrase(ctx: ReportContext, sentence = false): string {
  const { run } = ctx;
  const after = run.durationMs !== undefined ? ` in ${formatDuration(run.durationMs)}` : '';
  switch (run.status) {
    case 'running':
      return sentence ? 'is still running' : 'running';
    case 'success':
      return `succeeded${after}`;
    case 'cancelled': {
      const block = stoppedAt(ctx);
      const phrase = block
        ? `cancelled at ${escapeText(block.id)}`
        : `cancelled${after.replace(' in ', ' after ')}`;
      return sentence ? `was ${phrase}` : phrase;
    }
    case 'failure': {
      const block = stoppedAt(ctx);
      const error = (block && errorOf(block)) ?? run.error;
      const detail = error ? `: ${escapeText(cutChars(oneLine(error), ERROR_MAX_CHARS))}` : '';
      return block ? `failed at ${escapeText(block.id)}${detail}` : `failed${detail}`;
    }
  }
}

const COUNT_ORDER: [BlockState, string][] = [
  ['success', 'succeeded'],
  ['failure', 'failed'],
  ['cancelled', 'cancelled'],
  ['running', 'running'],
  ['pending', 'waiting'],
  ['skipped', 'skipped'],
  ['reused', 'reused'],
  ['not-run', 'not run'],
];

/** "5 succeeded, 1 failed, 2 skipped" for the blocks of the report. */
export function blockCounts(blocks: ReportBlock[]): string {
  const parts = COUNT_ORDER.flatMap(([state, label]) => {
    const count = blocks.filter((block) => block.state === state).length;
    return count > 0 ? [`${formatNumber(count)} ${label}`] : [];
  });
  return parts.length > 0 ? parts.join(', ') : 'none ran';
}

/** "12,345 in / 678 out", or undefined when no tokens were used. */
export function tokensText(ctx: ReportContext): string | undefined {
  const { usage } = ctx.run;
  if (usage.inputTokens + usage.outputTokens <= 0) return undefined;
  return `${formatNumber(usage.inputTokens)} in / ${formatNumber(usage.outputTokens)} out`;
}

/**
 * Changed files as list items ("`src/a.ts` +12 −3"), at most `max`, then "and N more"; `total` ("3 files") and
 * `decisions` ("1 kept, 2 pending") for the line above. Undefined when the review is unknown or empty.
 */
export function fileItems(
  ctx: ReportContext,
  max: number,
  detailed: boolean,
): { total: string; decisions?: string; items: string[] } | undefined {
  const { review } = ctx.input;
  if (!review || (review.files.length === 0 && !review.omitted)) return undefined;
  const total = review.files.length + (review.omitted ?? 0);
  const decisions = reviewSummary(ctx);
  const shown = review.files.slice(0, Math.max(0, max));
  const items = shown.map((file) => {
    const detail = detailed ? `, ${file.status}, ${file.decision}` : '';
    return `${code(file.path)} ${changesText(file)}${detail}`;
  });
  if (total > shown.length) items.push(`and ${formatNumber(total - shown.length)} more`);
  return { total: plural(total, 'file'), ...(decisions && { decisions }), items };
}
