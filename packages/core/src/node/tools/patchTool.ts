import { requiredString } from './args';
import { planFile } from './patchApply';
import { clip, plural, readEditableText } from './text';
import { type ToolContext, ToolError, type ToolImpl } from './toolContext';
import { type FilePatch, parseUnifiedDiff, patchPath } from './unifiedDiff';
import { assertWritable, errorText, recheckPath } from './writeGuard';

const DETAIL_MAX = 800;

interface Target {
  file: FilePatch;
  /** Path as written in the patch, resolved again after asking. */
  input: string;
  absPath: string;
  rel: string;
}

interface Planned extends Target {
  /** Text before the change; undefined when the patch creates the file. */
  original: string | undefined;
  /** Text after the change; null when the patch deletes the file. */
  content: string | null;
  added: number;
  removed: number;
  notes: string[];
}

/**
 * Applies a unified diff to one or more files, all or nothing: every file is planned before anything is
 * written, the user is asked once, and a failed write puts back the files written before it.
 */
export const applyPatch: ToolImpl = async (args, ctx) => {
  const patch = requiredString(args, 'patch');
  if (patch.trim() === '') throw new ToolError('"patch" is empty. Pass a unified diff.');
  const targets = await resolveTargets(ctx, parseUnifiedDiff(patch));
  if (targets.some((target) => target.file.newPath === null) && !ctx.workspace.deleteFile) {
    throw new ToolError(
      'Deleting files is not available here, so the patch was not applied. ' +
        'Leave out the sections with "+++ /dev/null".',
    );
  }
  const first = await planAll(ctx, targets);
  await ctx.authorize('applyPatch', summary(first), clip(patch, DETAIL_MAX));
  // Files may have changed and links may have appeared while the user was deciding.
  for (const target of targets) await recheckPath(ctx, target.input, target.absPath, target.rel);
  const planned = await planAll(ctx, targets);
  await writeAll(ctx, planned);
  return report(planned);
};

async function resolveTargets(ctx: ToolContext, files: FilePatch[]): Promise<Target[]> {
  const targets: Target[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const input = patchPath(file);
    const absPath = await ctx.resolvePath(input);
    const rel = ctx.displayPath(absPath);
    await assertWritable(ctx, absPath, rel);
    const key = process.platform === 'win32' ? rel.toLowerCase() : rel;
    if (seen.has(key)) {
      throw new ToolError(
        `The patch changes ${rel} more than once. Put all changes to a file into one section.`,
      );
    }
    seen.add(key);
    targets.push({ file, input, absPath, rel });
  }
  return targets.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Plans every file on its current text; throws one error that lists every problem. */
async function planAll(ctx: ToolContext, targets: Target[]): Promise<Planned[]> {
  const planned: Planned[] = [];
  const failures: string[] = [];
  for (const target of targets) {
    let original: string | undefined;
    try {
      original = (await ctx.workspace.exists(target.absPath))
        ? await readEditableText(ctx, target.absPath, target.rel)
        : undefined;
    } catch (error) {
      failures.push(errorText(error));
      continue;
    }
    const plan = planFile(target.file, target.rel, original);
    if (plan.ok) planned.push({ ...target, original, ...plan });
    else failures.push(...plan.failures);
  }
  if (failures.length === 1) {
    throw new ToolError(`${failures[0]} No file was changed. Read the file again and make a new patch.`);
  }
  if (failures.length > 1) {
    throw new ToolError(
      [
        'The patch was not applied; no file was changed:',
        ...failures.map((failure) => `- ${failure}`),
        'Read the files again and make a new patch.',
      ].join('\n'),
    );
  }
  return planned;
}

function summary(planned: Planned[]): string {
  const creates = planned.filter((p) => p.original === undefined).length;
  const deletes = planned.filter((p) => p.content === null).length;
  const extras = [creates > 0 && `creates ${creates}`, deletes > 0 && `deletes ${deletes}`].filter(Boolean);
  const what = planned.length === 1 ? planned[0].rel : `${planned.length} files`;
  return `Patch ${what}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`;
}

async function writeAll(ctx: ToolContext, planned: Planned[]): Promise<void> {
  const done: Planned[] = [];
  for (const file of planned) {
    try {
      await apply(ctx, file);
    } catch (error) {
      const verb = file.content === null ? 'delete' : 'write';
      const restored = await restore(ctx, [file, ...[...done].reverse()], done);
      throw new ToolError(`Could not ${verb} ${file.rel}: ${errorText(error)}. ${restored}`);
    }
    done.push(file);
  }
}

async function apply(ctx: ToolContext, file: Planned): Promise<void> {
  if (file.content !== null) return ctx.workspace.writeFile(file.absPath, file.content);
  if (!ctx.workspace.deleteFile) throw new Error('deleting files is not available');
  return ctx.workspace.deleteFile(file.absPath);
}

/** Puts files back as they were before the patch; says what happened, for the model and the run log. */
async function restore(ctx: ToolContext, files: Planned[], done: Planned[]): Promise<string> {
  const failed: string[] = [];
  const restored: string[] = [];
  for (const file of files) {
    try {
      if (file.original !== undefined) await ctx.workspace.writeFile(file.absPath, file.original);
      else if (await ctx.workspace.exists(file.absPath)) await ctx.workspace.deleteFile?.(file.absPath);
      if (done.includes(file)) restored.push(file.rel);
    } catch (error) {
      failed.push(`${file.rel} (${errorText(error)})`);
    }
  }
  const names = restored.sort().join(', ');
  if (failed.length === 0) {
    return done.length === 0
      ? 'No file was changed.'
      : `The files changed before it were restored (${names}), so no file was changed.`;
  }
  const list = failed.sort().join(', ');
  return restored.length === 0
    ? `Restoring the files changed before it failed: ${list}. Check these files.`
    : `Restored ${names}, but restoring failed for ${list}. Check these files.`;
}

function report(planned: Planned[]): string {
  const parts = planned.map((file) => {
    if (file.content === null) return `${file.rel} (deleted, −${file.removed})`;
    if (file.original === undefined) return `${file.rel} (new, +${file.added})`;
    return `${file.rel} (+${file.added} −${file.removed})`;
  });
  const notes = planned.flatMap((file) => file.notes);
  return [`Patched ${plural(planned.length, 'file')}: ${parts.join(', ')}.`, ...notes].join('\n');
}
