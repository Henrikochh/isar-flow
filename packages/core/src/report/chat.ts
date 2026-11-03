import { blockLabel, executed, type ReportBlock } from './blocks';
import {
  answerMarkdown,
  answerOf,
  approvalDecision,
  askAnswer,
  errorOf,
  exitCodeOf,
  type Limits,
  originSentence,
  outputTail,
  type ReportContext,
  runNotes,
  SHORTENED,
} from './facts';
import { cutChars, escapeText, oneLine } from './format';
import { fileItems, statusPhrase, tokensText } from './summary';

export const CHAT_LIMITS: Limits = { answerChars: 2000, logLines: 10, files: 30 };
export const CHAT_MAX_CHARS = 16000;

/**
 * Result of Copilot's run tool and of `@isarflow /run`: the outcome, the outputs of the blocks that ran, errors and
 * changed files.
 */
export function chatReport(ctx: ReportContext, limits: Limits): string {
  const phrase = statusPhrase(ctx, true);
  const intro = [`**${escapeText(ctx.name)}** ${phrase}${/[.!?]$/.test(phrase) ? '' : '.'}`];
  const tokens = tokensText(ctx);
  if (tokens) intro.push(`Tokens: ${tokens}.`);
  const origin = originSentence(ctx);
  if (origin) intro.push(`${escapeText(origin)}.`);
  intro.push(...runNotes(ctx));

  const parts = [intro.join('\n\n')];
  const outputs = ctx.blocks.filter(executed).flatMap((block) => blockOutput(block, limits));
  if (outputs.length > 0) parts.push(`### Outputs\n\n${outputs.join('\n\n')}`);

  const errors = ctx.blocks
    .filter((block) => block.state === 'failure' && executed(block))
    .map(
      (block) =>
        `- ${blockLabel(block)}: ${escapeText(cutChars(oneLine(errorOf(block) ?? 'The block failed.'), 500))}`,
    );
  const runError = ctx.run.error?.trim();
  if (runError && !ctx.blocks.some((block) => errorOf(block) === runError)) {
    errors.unshift(`- ${escapeText(cutChars(oneLine(runError), 500))}`);
  }
  if (errors.length > 0) parts.push(`### Errors\n\n${errors.join('\n')}`);

  const files = fileItems(ctx, limits.files, true);
  if (files) {
    const decisions = files.decisions ? ` (${files.decisions})` : '';
    const list = files.items.map((item) => `- ${item}`).join('\n');
    parts.push(`### Changed files\n\n${files.total} changed${decisions}.\n\n${list}`);
  }
  return `${parts.join('\n\n')}\n`;
}

function blockOutput(block: ReportBlock, limits: Limits): string[] {
  const title = `**${blockLabel(block)}**`;
  switch (block.type) {
    case 'console': {
      const exitCode = exitCodeOf(block.view);
      const tail = outputTail(block.view, limits.logLines);
      if (exitCode === undefined && !tail) return [];
      const head = `${title} (console)${exitCode !== undefined ? `: exit code ${exitCode}` : ''}`;
      return [tail ? `${head}\n\n${tail}` : head];
    }
    case 'agent': {
      const answer = answerOf(block);
      if (!answer) return [];
      const text = limits.answerChars > 0 ? answerMarkdown(answer, limits.answerChars) : SHORTENED;
      return [`${title} (agent):\n\n${text}`];
    }
    case 'ask': {
      const answer = askAnswer(block.view);
      return answer ? [`${title} (ask): ${answer}`] : [];
    }
    case 'approval': {
      const decision = approvalDecision(block.view);
      return decision ? [`${title} (approval): ${decision}`] : [];
    }
    default:
      return [];
  }
}
