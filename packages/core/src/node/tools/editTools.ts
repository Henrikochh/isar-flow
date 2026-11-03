import { requiredString } from './args';
import { clip, lineCount, plural, readEditableText } from './text';
import { type MatchMode, replaceOnce } from './tolerantMatch';
import { type ToolContext, ToolError, type ToolImpl } from './toolContext';
import { assertWritable, recheckPath, writeOrThrow } from './writeGuard';

const DETAIL_MAX = 800;

/** How a looser match is named in errors ("matches 3 places … (ignoring whitespace)"). */
const MODE_NAME: Record<MatchMode, string> = {
  exact: '',
  lineEndings: ' (after normalizing line endings)',
  whitespace: ' (ignoring whitespace)',
};

/** What the result says about a looser match. */
const MODE_NOTE: Record<MatchMode, string> = {
  exact: '',
  lineEndings: ' (matched after normalizing line endings)',
  whitespace: ' (matched ignoring whitespace; indentation taken from the file)',
};

export const editFile: ToolImpl = async (args, ctx) => {
  const input = requiredString(args, 'path');
  const oldText = requiredString(args, 'oldText');
  const newText = requiredString(args, 'newText');
  if (oldText === '') {
    throw new ToolError(
      '"oldText" is empty. Copy the exact text to replace from the file, or use writeFile.',
    );
  }
  const absPath = await ctx.resolvePath(input);
  const rel = ctx.displayPath(absPath);
  await assertWritable(ctx, absPath, rel);
  await applyEdit(ctx, absPath, rel, oldText, newText);
  await ctx.authorize(
    'editFile',
    `Edit ${rel}`,
    `Replace:\n${clip(oldText, DETAIL_MAX)}\n\nWith:\n${clip(newText, DETAIL_MAX)}`,
  );
  // The file may have changed while the user was deciding, so the edit is planned again on fresh text.
  await recheckPath(ctx, input, absPath, rel);
  const { content, mode } = await applyEdit(ctx, absPath, rel, oldText, newText);
  await writeOrThrow(ctx, absPath, rel, content);
  const counts = `replaced ${plural(lineCount(oldText), 'line')} with ${plural(lineCount(newText), 'line')}`;
  return `Edited ${rel}: ${counts}${MODE_NOTE[mode]}.`;
};

export const writeFile: ToolImpl = async (args, ctx) => {
  const input = requiredString(args, 'path');
  const content = requiredString(args, 'content');
  const absPath = await ctx.resolvePath(input);
  const rel = ctx.displayPath(absPath);
  await assertWritable(ctx, absPath, rel);
  const existed = await ctx.workspace.exists(absPath);
  const lines = plural(lineCount(content), 'line');
  await ctx.authorize(
    'writeFile',
    `${existed ? 'Overwrite' : 'Create'} ${rel}`,
    `${lines}:\n${clip(content, DETAIL_MAX)}`,
  );
  await recheckPath(ctx, input, absPath, rel);
  await writeOrThrow(ctx, absPath, rel, content);
  return `${existed ? 'Wrote' : 'Created'} ${rel} (${lines}).`;
};

/** The file content after replacing the single match of oldText; throws when there is not exactly one. */
async function applyEdit(
  ctx: ToolContext,
  absPath: string,
  rel: string,
  oldText: string,
  newText: string,
): Promise<{ content: string; mode: MatchMode }> {
  if (!(await ctx.workspace.exists(absPath))) {
    throw new ToolError(
      `File not found: ${rel}. editFile changes existing files; use writeFile to create one.`,
    );
  }
  const result = replaceOnce(await readEditableText(ctx, absPath, rel), oldText, newText);
  switch (result.kind) {
    case 'replaced':
      return { content: result.content, mode: result.mode };
    case 'ambiguous':
      throw new ToolError(
        `oldText matches ${result.count} places in ${rel}${MODE_NAME[result.mode]}. ` +
          'Include more surrounding lines so it matches exactly once.',
      );
    case 'notFound':
      throw new ToolError(
        `oldText was not found in ${rel}, also not when ignoring whitespace and line endings. ` +
          'Read the file again and copy the text to replace exactly.',
      );
  }
}
