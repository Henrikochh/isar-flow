/** Editing rules of an ask block's answers: choices, their order and the default that follows them. */

export type AnswerMode = 'free' | 'choices';

/** Choices as written (non-text entries left out); an empty list means a free text question. */
export function choicesOf(step: Record<string, unknown>): string[] {
  return Array.isArray(step.choices)
    ? step.choices.filter((choice): choice is string => typeof choice === 'string')
    : [];
}

export function defaultOf(step: Record<string, unknown>): string {
  const value = step.default;
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** One message per row: empty rows are fine (never written); a repeated choice is marked where it repeats. */
export function choiceProblems(rows: string[]): (string | undefined)[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const text = row.trim();
    if (text === '') return undefined;
    if (seen.has(text)) return `'${text}' is listed twice.`;
    seen.add(text);
    return undefined;
  });
}

export interface StepChange {
  set: Record<string, unknown>;
  unset: string[];
}

/**
 * The edit for a new list of choices. The default follows its choice when that choice is renamed and goes away
 * when it is removed, so the block never points at an answer it does not offer. No choices: free text.
 */
export function choicesChange(before: string[], after: string[], current: string): StepChange {
  if (after.length === 0) return { set: {}, unset: ['choices'] };
  const set: Record<string, unknown> = { choices: after };
  const unset: string[] = [];
  if (current !== '' && !after.includes(current)) {
    const index = before.indexOf(current);
    if (index >= 0 && before.length === after.length) set.default = after[index];
    else unset.push('default');
  }
  return { set, unset };
}
