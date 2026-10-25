import { describe, expect, it } from 'vitest';
import { ISAR_FLOW_VERSION } from '../src/index';

describe('core', () => {
  it('exports a version', () => {
    expect(ISAR_FLOW_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
