const ESC = '\x1b[';

export interface Style {
  dim(text: string): string;
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
}

const paint = (code: number) => (text: string) => (text === '' ? '' : `${ESC}${code}m${text}${ESC}0m`);
const plain = (text: string) => text;

/** ANSI colors, or plain text when colors are off. */
export function createStyle(color: boolean): Style {
  if (!color) return { dim: plain, green: plain, red: plain, yellow: plain };
  return { dim: paint(2), green: paint(32), red: paint(31), yellow: paint(33) };
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** "1 block", "3 blocks". */
export function plural(count: number, word: string): string {
  return `${formatCount(count)} ${word}${count === 1 ? '' : 's'}`;
}

/** "a", "a and b", "a, b and c". */
export function listText(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
