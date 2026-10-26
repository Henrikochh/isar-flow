import { requiredString } from './args';
import { clip, lineCount, plural, readWorkspaceText } from './text';
import { type ToolContext, ToolError, type ToolImpl } from './types';

const DETAIL_MAX = 800;
const MAX_COUNTED = 1000;

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
  const content = await applyEdit(ctx, absPath, rel, oldText, newText);
  await write(ctx, absPath, rel, content);
  return `Edited ${rel}: replaced ${plural(lineCount(oldText), 'line')} with ${plural(lineCount(newText), 'line')}.`;
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
  await write(ctx, absPath, rel, content);
  return `${existed ? 'Wrote' : 'Created'} ${rel} (${lines}).`;
};

/** The file content after replacing the single occurrence of oldText; throws when it is not exactly one. */
async function applyEdit(
  ctx: ToolContext,
  absPath: string,
  rel: string,
  oldText: string,
  newText: string,
): Promise<string> {
  if (!(await ctx.workspace.exists(absPath))) {
    throw new ToolError(
      `File not found: ${rel}. editFile changes existing files; use writeFile to create one.`,
    );
  }
  const text = await readWorkspaceText(ctx, absPath, rel);
  // readFile shows LF line ends, so the model sends LF; a CRLF file keeps its line ends.
  const candidates: [string, string][] = text.includes('\r\n')
    ? [
        [toCrlf(oldText), toCrlf(newText)],
        [oldText, newText],
      ]
    : [[oldText, newText]];
  for (const [needle, replacement] of candidates) {
    const count = countOccurrences(text, needle);
    if (count > 1) {
      throw new ToolError(
        `oldText occurs ${count} times in ${rel}; include more surrounding lines so it matches exactly once.`,
      );
    }
    if (count === 1) {
      const index = text.indexOf(needle);
      return text.slice(0, index) + replacement + text.slice(index + needle.length);
    }
  }
  throw new ToolError(
    `oldText was not found in ${rel}. Read the file again and copy the text exactly, including whitespace and indentation.`,
  );
}

async function write(ctx: ToolContext, absPath: string, rel: string, content: string): Promise<void> {
  try {
    await ctx.workspace.writeFile(absPath, content);
  } catch (error) {
    throw new ToolError(`Could not write ${rel}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Refuses the folder itself and anything inside .git, also when a link, junction or Windows short name
 * (GIT~1) leads there, or a trailing dot or space hides the name (Windows drops them).
 */
async function assertWritable(ctx: ToolContext, absPath: string, rel: string): Promise<void> {
  if (rel === '.') throw new ToolError('The path is the workspace folder itself. Pass a file path.');
  const real = await ctx.realDisplayPath(absPath);
  if (real === '.') throw new ToolError('The path is the workspace folder itself. Pass a file path.');
  if (isInsideGit(rel) || isInsideGit(real)) {
    throw new ToolError('Files inside .git cannot be changed. Use runCommand with git instead.');
  }
}

/** Checks the path again right before writing: a link may have been created while the user was asked. */
async function recheckPath(ctx: ToolContext, input: string, absPath: string, rel: string): Promise<void> {
  await ctx.resolvePath(input);
  await assertWritable(ctx, absPath, rel);
}

function isInsideGit(rel: string): boolean {
  return rel.split('/').some((part) => part.replace(/[. ]+$/, '').toLowerCase() === '.git');
}

/** Counts occurrences including overlapping ones, which would make the replacement ambiguous too. */
function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let i = text.indexOf(needle); i !== -1 && count < MAX_COUNTED; i = text.indexOf(needle, i + 1))
    count++;
  return count;
}

function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}
