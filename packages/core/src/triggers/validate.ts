import type { Diagnostic } from '../diagnostics';
import type { Workflow } from '../schema/types';
import { MIN_SCHEDULE_MS, parseDuration } from './duration';
import { triggerSummaries } from './summaries';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const OUTSIDE = 'File patterns are relative to the workspace folder.';

/** Why a pattern points outside the workspace folder, as the fix; undefined when it is inside. */
function outsideFix(pattern: string): string | undefined {
  const path = pattern.startsWith('!') ? pattern.slice(1) : pattern;
  if (/^[A-Za-z]:/.test(path)) return 'Remove the drive letter.';
  if (/^[\\/]/.test(path)) return 'Remove the leading slash.';
  if (path.split(/[\\/]/).includes('..')) return "Remove '..'.";
  return undefined;
}

function fileDiagnostics(kind: 'save' | 'change', trigger: unknown): Diagnostic[] {
  const files = isRecord(trigger) ? trigger.files : undefined;
  const base = ['on', kind, 'files'];
  const entries: [string, (string | number)[]][] =
    typeof files === 'string'
      ? [[files, base]]
      : Array.isArray(files)
        ? files.flatMap((file: unknown, i) => (typeof file === 'string' ? [[file, [...base, i]]] : []))
        : [];
  const diagnostics: Diagnostic[] = [];
  for (const [pattern, path] of entries) {
    const fix = outsideFix(pattern);
    if (fix)
      diagnostics.push({
        severity: 'error',
        code: 'trigger-pattern-outside',
        message: `${OUTSIDE} ${fix}`,
        path,
      });
  }
  const patterns = entries.map(([pattern]) => pattern.trim()).filter((pattern) => pattern !== '');
  if (patterns.length > 0 && patterns.every((pattern) => pattern.startsWith('!'))) {
    diagnostics.push({
      severity: 'warning',
      code: 'trigger-only-exclusions',
      message: "Add a pattern to match, e.g. 'src/**'; patterns starting with ! only exclude.",
      path: base,
    });
  }
  return diagnostics;
}

function scheduleDiagnostics(trigger: unknown): Diagnostic[] {
  const every = isRecord(trigger) ? trigger.every : undefined;
  const ms = typeof every === 'string' ? parseDuration(every) : undefined;
  if (ms === undefined || ms >= MIN_SCHEDULE_MS) return [];
  return [
    {
      severity: 'error',
      code: 'schedule-too-short',
      message: 'Schedules run at most once a minute. Use 1m or more.',
      path: ['on', 'schedule', 'every'],
    },
  ];
}

const isMissing = (value: unknown) => value === undefined || value === null || value === '';

/** Required inputs without default: a triggered run has nobody to enter them. */
function inputDiagnostics(workflow: Workflow): Diagnostic[] {
  if (triggerSummaries(workflow.on).length === 0 || !isRecord(workflow.inputs)) return [];
  return Object.entries(workflow.inputs).flatMap(([name, input]): Diagnostic[] =>
    isRecord(input) && input.required === true && isMissing(input.default)
      ? [
          {
            severity: 'warning',
            code: 'trigger-required-input',
            message: `Triggers can't ask for inputs. Give input '${name}' a default or make it optional.`,
            path: ['inputs', name],
          },
        ]
      : [],
  );
}

/** Problems of a workflow's `on:` that the schema doesn't catch. Reads lenient (possibly malformed) workflows. */
export function triggerDiagnostics(workflow: Workflow): Diagnostic[] {
  const on: unknown = isRecord(workflow) ? workflow.on : undefined;
  if (!isRecord(on)) return [];
  return [
    ...fileDiagnostics('save', on.save),
    ...fileDiagnostics('change', on.change),
    ...scheduleDiagnostics(on.schedule),
    ...inputDiagnostics(workflow),
  ];
}
