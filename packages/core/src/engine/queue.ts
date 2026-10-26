/**
 * Unbounded single-consumer queue. Producers push synchronously (hosts log from async callbacks);
 * the run generator drains it, so events keep the order in which they happened.
 */
export class EventQueue<T> {
  private readonly items: T[] = [];
  private closed = false;
  private wake: (() => void) | undefined;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  async next(): Promise<IteratorResult<T, undefined>> {
    for (;;) {
      if (this.items.length > 0) return { done: false, value: this.items.shift() as T };
      if (this.closed) return { done: true, value: undefined };
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
