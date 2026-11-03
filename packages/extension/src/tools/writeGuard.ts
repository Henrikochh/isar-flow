import { type ToolContext, ToolError } from './types';

/**
 * Refuses the folder itself and anything inside .git, also when a link, junction or Windows short name
 * (GIT~1) leads there, or a trailing dot or space hides the name (Windows drops them).
 */
export async function assertWritable(ctx: ToolContext, absPath: string, rel: string): Promise<void> {
  if (rel === '.') throw new ToolError('The path is the workspace folder itself. Pass a file path.');
  const real = await ctx.realDisplayPath(absPath);
  if (real === '.') throw new ToolError('The path is the workspace folder itself. Pass a file path.');
  if (isInsideGit(rel) || isInsideGit(real)) {
    throw new ToolError('Files inside .git cannot be changed. Use runCommand with git instead.');
  }
}

/** Checks the path again right before writing: a link may have been created while the user was asked. */
export async function recheckPath(
  ctx: ToolContext,
  input: string,
  absPath: string,
  rel: string,
): Promise<void> {
  await ctx.resolvePath(input);
  await assertWritable(ctx, absPath, rel);
}

export async function writeOrThrow(
  ctx: ToolContext,
  absPath: string,
  rel: string,
  content: string,
): Promise<void> {
  try {
    await ctx.workspace.writeFile(absPath, content);
  } catch (error) {
    throw new ToolError(`Could not write ${rel}: ${errorText(error)}`);
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInsideGit(rel: string): boolean {
  return rel.split('/').some((part) => part.replace(/[. ]+$/, '').toLowerCase() === '.git');
}
