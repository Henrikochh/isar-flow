/**
 * Decodes one output stream as UTF-8, keeping characters whose bytes arrive in different chunks whole,
 * and turns CRLF into LF so captured output looks the same on every platform. Lone CRs (progress
 * output) stay.
 */
export class StreamDecoder {
  private readonly decoder = new TextDecoder('utf-8');
  private pendingCR = false;

  write(chunk: Uint8Array): string {
    return this.normalize(this.decoder.decode(chunk, { stream: true }), false);
  }

  /** Returns what is still buffered; call once when the stream ended. */
  end(): string {
    return this.normalize(this.decoder.decode(), true);
  }

  private normalize(text: string, final: boolean): string {
    if (this.pendingCR) {
      text = `\r${text}`;
      this.pendingCR = false;
    }
    // A CR at the end of a chunk may be the first half of a CRLF; wait for the next chunk to decide.
    if (!final && text.endsWith('\r')) {
      this.pendingCR = true;
      text = text.slice(0, -1);
    }
    return text.replace(/\r\n/g, '\n');
  }
}
