import {
  answerMarkdown,
  answerOf,
  costText,
  type Limits,
  originSentence,
  type ReportContext,
  lastAnswer,
  runNotes,
} from './facts';
import { escapeText } from './format';
import { blockCounts, fileItems, statusPhrase, tokensText } from './summary';

export const PR_LIMITS: Limits = { answerChars: 1500, logLines: 0, files: 15 };
export const PR_MAX_CHARS = 4000;

/** "Copy for PR description": a heading with the outcome, a few bullets and the last agent answer. */
export function prReport(ctx: ReportContext, limits: Limits): string {
  const bullets = [`Blocks: ${blockCounts(ctx.blocks)}`];
  const tokens = tokensText(ctx);
  if (tokens) bullets.push(`Tokens: ${tokens}`);
  const cost = costText(ctx.run, ctx.input.prices);
  if (cost) bullets.push(`Cost: ${cost}`);
  const files = fileItems(ctx, limits.files, false);
  if (files) {
    const decisions = files.decisions ? ` (${files.decisions})` : '';
    const headline = `Changed files: ${files.total}${decisions}`;
    bullets.push([headline, ...files.items.map((item) => `  - ${item}`)].join('\n'));
  } else if (!ctx.run.simulated) {
    bullets.push('Changed files: none');
  }
  const origin = originSentence(ctx);
  if (origin) bullets.push(escapeText(origin));
  bullets.push(...runNotes(ctx));

  const parts = [
    `### ${escapeText(ctx.name)}: ${statusPhrase(ctx)}`,
    bullets.map((b) => `- ${b}`).join('\n'),
  ];
  const block = lastAnswer(ctx.blocks);
  const answer = block && answerOf(block);
  if (answer && limits.answerChars > 0) {
    parts.push(
      `<details><summary>Agent answer</summary>\n\n${answerMarkdown(answer, limits.answerChars)}\n\n</details>`,
    );
  }
  return `${parts.join('\n\n')}\n`;
}
