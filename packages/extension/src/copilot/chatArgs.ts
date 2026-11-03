export type RunPrompt = { workflow: string; inputs: Record<string, string> } | { error: string };

const USAGE = 'Name a workflow: /run <workflow> [name=value …]';
const UNCLOSED = 'A quote is not closed. Close it, then run again.';

interface Token {
  text: string;
  /** Index of the first unquoted `=`, if any. */
  equals: number;
}

/** Splits at unquoted whitespace; '…' and "…" group text (adjacent parts join, as in a shell). */
function tokenize(prompt: string): Token[] | undefined {
  const tokens: Token[] = [];
  let current: Token | undefined;
  let quote: string | undefined;
  for (const char of prompt) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current = { text: (current?.text ?? '') + char, equals: current?.equals ?? -1 };
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
      current ??= { text: '', equals: -1 };
    } else {
      current ??= { text: '', equals: -1 };
      if (char === '=' && current.equals < 0) current.equals = current.text.length;
      current.text += char;
    }
  }
  if (quote) return undefined;
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Reads `/run <workflow> [name=value …]`. The workflow is every word before the first `name=value`, so names with
 * spaces work with and without quotes.
 */
export function parseRunPrompt(prompt: string): RunPrompt {
  const tokens = tokenize(prompt);
  if (!tokens) return { error: UNCLOSED };
  const firstInput = tokens.findIndex((token) => token.equals > 0);
  const nameTokens = firstInput < 0 ? tokens : tokens.slice(0, firstInput);
  const workflow = nameTokens
    .map((token) => token.text)
    .join(' ')
    .trim();
  if (workflow === '') return { error: USAGE };
  const inputs: Record<string, string> = {};
  for (const token of firstInput < 0 ? [] : tokens.slice(firstInput)) {
    if (token.equals <= 0) {
      return { error: `Write inputs as name=value, e.g. version=1.2.0. '${token.text}' has no value.` };
    }
    inputs[token.text.slice(0, token.equals)] = token.text.slice(token.equals + 1);
  }
  return { workflow, inputs };
}
