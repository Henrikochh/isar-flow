import { describe, expect, it } from 'vitest';

describe('extension unit tests', () => {
  it('run in node', () => {
    expect(typeof process.platform).toBe('string');
  });
});
