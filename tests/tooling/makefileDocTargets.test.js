import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function dryRun(target) {
  return execFileSync('make', ['--no-print-directory', '-n', target], { encoding: 'utf8' });
}

describe('Makefile doc target shortcuts', () => {
  test('every doc-targets/*.json file has a docs-<name> shortcut', () => {
    const names = fs
      .readdirSync(path.resolve(process.cwd(), 'doc-targets'))
      .filter((file) => file.endsWith('.json'))
      .map((file) => path.basename(file, '.json'));

    for (const name of names) {
      expect(dryRun(`docs-${name}`)).toContain(`scripts/use-doc-target.js use ${name}`);
    }
  });

  test('legacy short names resolve to their doc targets', () => {
    expect(dryRun('docs-claude')).toContain('use claude-code');
    expect(dryRun('docs-cloudflare')).toContain('use cloudflare-blog');
    expect(dryRun('docs-anthropic')).toContain('use anthropic-research');
    expect(dryRun('docs-openai')).toContain('use openai');
  });

  test('docs-current and docs-list run the doc target script', () => {
    expect(dryRun('docs-current')).toContain('scripts/use-doc-target.js current');
    expect(dryRun('docs-list')).toContain('scripts/use-doc-target.js list');
  });
});
