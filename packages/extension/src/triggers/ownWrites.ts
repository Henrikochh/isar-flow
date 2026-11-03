/**
 * File events a workflow caused itself: its triggers drop them for a short time after one of its runs, so a
 * workflow that edits files matching its own trigger does not start itself again.
 */
export class OwnWrites {
  private allUntil = 0;
  /** Path key → drop events of that file until then. */
  private readonly files = new Map<string, number>();

  get size(): number {
    return this.files.size;
  }

  dropAll(until: number): void {
    this.allUntil = Math.max(this.allUntil, until);
  }

  dropFiles(keys: readonly string[], until: number, now: number): void {
    for (const [key, time] of this.files) if (time <= now) this.files.delete(key);
    for (const key of keys) this.files.set(key, Math.max(this.files.get(key) ?? 0, until));
  }

  drops(key: string, now: number): boolean {
    if (now < this.allUntil) return true;
    const until = this.files.get(key);
    if (until === undefined) return false;
    if (now < until) return true;
    this.files.delete(key);
    return false;
  }
}
