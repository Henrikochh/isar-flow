/**
 * The choice an answer of an ask block stands for: the exact choice, else the first that differs only in case
 * (so the answer gets the choice's spelling); undefined when it is none of them.
 */
export function matchChoice(answer: string, choices: readonly string[]): string | undefined {
  if (choices.includes(answer)) return answer;
  const folded = answer.toLowerCase();
  return choices.find((choice) => choice.toLowerCase() === folded);
}

/** "a, b, c" for messages. */
export const choiceList = (choices: readonly string[]) => choices.join(', ');
