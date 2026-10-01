import { describe, expect, test } from 'vitest';
import path from 'node:path';
import { isPathInside } from '../../src/utils/paths.js';

describe('isPathInside', () => {
  const root = path.resolve('/srv/repo');

  test('accepts the root itself and paths below it', () => {
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, path.join(root, 'config.json'))).toBe(true);
    expect(isPathInside(root, path.join(root, 'doc-targets', 'a.json'))).toBe(true);
  });

  test('rejects sibling directories that share the root as a string prefix', () => {
    expect(isPathInside(root, path.resolve('/srv/repo-evil/config.json'))).toBe(false);
  });

  test('rejects parent traversal and unrelated absolute paths', () => {
    expect(isPathInside(root, path.join(root, '..', 'other.json'))).toBe(false);
    expect(isPathInside(root, path.resolve('/etc/passwd'))).toBe(false);
  });

  test('accepts names that merely start with two dots', () => {
    expect(isPathInside(root, path.join(root, '..notes.json'))).toBe(true);
  });

  test('resolves relative paths against the working directory', () => {
    expect(isPathInside(process.cwd(), 'config.json')).toBe(true);
    expect(isPathInside(process.cwd(), '../outside.json')).toBe(false);
  });
});
