/** Captured text per stream is limited to this many characters (about 4 MB for ASCII output). */
export const MAX_CAPTURE_CHARS = 4 * 1024 * 1024;

/**
 * Collects a growing text but keeps at most `limit` characters: the first and the last half, with a
 * "… N bytes omitted …" line in between once something had to be dropped.
 */
export class CappedText {
  private readonly half: number;
  private head = '';
  private headFull = false;
  private tail = '';
  private omittedBytes = 0;

  constructor(private readonly limit = MAX_CAPTURE_CHARS) {
    this.half = Math.max(1, Math.floor(limit / 2));
  }

  get truncated(): boolean {
    return this.omittedBytes > 0;
  }

  append(text: string): void {
    if (text === '') return;
    if (!this.headFull) {
      const room = this.half - this.head.length;
      if (text.length < room) {
        this.head += text;
        return;
      }
      const cut = safeCut(text, room);
      this.head += text.slice(0, cut);
      this.headFull = true;
      text = text.slice(cut);
    }
    this.tail += text;
    // Trimming only when the tail doubled keeps appends cheap (amortized) while memory stays bounded.
    if (this.tail.length > this.limit) this.trimTail();
  }

  toString(): string {
    this.trimTail();
    if (this.omittedBytes === 0) return this.head + this.tail;
    const separator = this.head.endsWith('\n') || this.head === '' ? '' : '\n';
    const count = this.omittedBytes.toLocaleString('en-US');
    return `${this.head}${separator}… ${count} bytes omitted …\n${this.tail}`;
  }

  private trimTail(): void {
    if (this.tail.length <= this.half) return;
    const cut = safeCut(this.tail, this.tail.length - this.half, true);
    this.omittedBytes += Buffer.byteLength(this.tail.slice(0, cut), 'utf8');
    this.tail = this.tail.slice(cut);
  }
}

/** Moves a cut index so it does not fall between the two halves of a surrogate pair. */
function safeCut(text: string, index: number, forward = false): number {
  if (index <= 0 || index >= text.length) return Math.max(0, Math.min(index, text.length));
  const before = text.charCodeAt(index - 1);
  if (before >= 0xd800 && before <= 0xdbff) return forward ? index + 1 : index - 1;
  return index;
}
