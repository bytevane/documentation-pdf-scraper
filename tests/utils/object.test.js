import { describe, expect, test } from 'vitest';
import { deepMerge, stableJson } from '../../src/utils/object.js';

describe('deepMerge', () => {
  test('merges nested objects and lets source arrays and primitives win', () => {
    const target = { a: 1, nested: { keep: true, list: [1, 2] } };
    const source = { b: 2, nested: { list: [3] } };

    expect(deepMerge(target, source)).toEqual({ a: 1, b: 2, nested: { keep: true, list: [3] } });
    expect(target.nested.list).toEqual([1, 2]);
  });

  test('treats non-object inputs as empty', () => {
    expect(deepMerge(null, { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge({ a: 1 }, null)).toEqual({ a: 1 });
  });
});

describe('stableJson', () => {
  test('is independent of key order and omits undefined values', () => {
    expect(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      stableJson({ a: { d: [1, { x: 1, y: 2 }] }, b: 1 })
    );
  });
});
