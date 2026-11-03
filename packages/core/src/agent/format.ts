export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The text without trailing periods and spaces, for embedding it in a longer sentence. */
export function withoutPeriod(text: string): string {
  return text.replace(/[.\s]+$/, '');
}

/** The text as one sentence ending with a period. */
export function sentence(text: string): string {
  return `${withoutPeriod(text)}.`;
}

/** `24,000`: rounded to a whole number, with thousands separators. */
export function formatNumber(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A token estimate for people: exact below 100, then rounded to tens and, from 1,000, to hundreds. */
export function formatTokens(tokens: number): string {
  const step = tokens < 100 ? 1 : tokens < 1000 ? 10 : 100;
  return formatNumber(Math.round(tokens / step) * step);
}
