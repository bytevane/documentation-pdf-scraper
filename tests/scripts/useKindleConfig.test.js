import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const script = path.resolve(process.cwd(), 'scripts/use-kindle-config.js');
const configFile = path.resolve(process.cwd(), 'config.json');

function run(...args) {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

describe('use-kindle-config.js', () => {
  test('use prints the PDF_PROFILE command and never rewrites config.json', () => {
    const before = fs.readFileSync(configFile, 'utf8');

    expect(run('use', 'oasis')).toContain('PDF_PROFILE=kindle-oasis npm start');
    run('reset');

    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
  });

  test('list shows every config-profiles file', () => {
    const output = run('list');
    for (const file of fs.readdirSync(path.resolve(process.cwd(), 'config-profiles'))) {
      expect(output).toContain(path.basename(file, '.json'));
    }
  });

  test('rejects names that are not profiles', () => {
    expect(() => run('use', '../config')).toThrow();
  });
});
