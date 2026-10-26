import { describe, expect, it } from 'vitest';
import { copyData, MaskedStream, SECRET_MASK, SecretMasker } from '../../src/engine/mask';

describe('copyData', () => {
  it('copies nested objects and arrays without sharing them', () => {
    const value = { a: [1, { b: 'x' }], c: null, d: true };
    const copy = copyData(value);
    expect(copy).toEqual(value);
    expect(copy).not.toBe(value);
    expect(copy.a).not.toBe(value.a);
    expect(copy.a[1]).not.toBe(value.a[1]);
  });

  it('applies the text function to every string, keys excluded', () => {
    expect(copyData({ key: ['a', { key: 'b' }], n: 1 }, (s) => s.toUpperCase())).toEqual({
      key: ['A', { key: 'B' }],
      n: 1,
    });
  });

  it('keeps a JSON key named __proto__ as a plain key', () => {
    const value = JSON.parse('{"__proto__": {"polluted": "yes"}}') as Record<string, unknown>;
    const copy = copyData(value);
    expect(Object.keys(copy)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
  });

  it('survives cycles and clones other objects', () => {
    const value: Record<string, unknown> = { when: new Date(0) };
    value.self = value;
    const copy = copyData(value);
    expect(copy.self).toBe(copy);
    expect(copy.when).toEqual(new Date(0));
    expect(copy.when).not.toBe(value.when);
  });
});

describe('SecretMasker', () => {
  const masker = new SecretMasker({ A: 'hunter2', B: 'hunter2-long', C: 'abc', D: 'hunter2' });

  it('replaces every occurrence, longest secret first, and ignores values under 4 characters', () => {
    expect(masker.text('x hunter2-long y hunter2 z abc')).toBe(`x ${SECRET_MASK} y ${SECRET_MASK} z abc`);
  });

  it('masks strings deep inside data', () => {
    expect(masker.data({ list: ['hunter2', 3], nested: { s: 'a hunter2' } })).toEqual({
      list: [SECRET_MASK, 3],
      nested: { s: `a ${SECRET_MASK}` },
    });
  });

  it('finds the longest end of a text that starts a secret', () => {
    expect(masker.partialLength('abc hun')).toBe(3);
    expect(masker.partialLength('abc hunter2-')).toBe(8);
    // A whole short secret can still be the start of a longer one.
    expect(masker.partialLength('hunter2')).toBe(7);
    expect(masker.partialLength('hunter2-long')).toBe(0);
    expect(masker.partialLength('abc')).toBe(0);
    expect(masker.partialLength('')).toBe(0);
  });

  it('does nothing without secrets', () => {
    const none = new SecretMasker(undefined);
    expect(none.text('hunter2')).toBe('hunter2');
    expect(none.partialLength('hun')).toBe(0);
  });
});

describe('MaskedStream', () => {
  it('holds back a possible secret start until the next chunk decides', () => {
    const stream = new MaskedStream(new SecretMasker({ T: 'token-123' }));
    expect(stream.push('a tok')).toBe('a ');
    expect(stream.push('en-1')).toBe('');
    expect(stream.push('23 and tok')).toBe(`${SECRET_MASK} and `);
    expect(stream.push('yo')).toBe('tokyo');
    expect(stream.push(' tok')).toBe(' ');
    expect(stream.flush()).toBe('tok');
    expect(stream.flush()).toBe('');
  });
});
