import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DOC_TARGET_ALIASES, listDocTargets } from '../../src/config/docTargets.js';

const targetsDir = path.resolve(process.cwd(), 'doc-targets');

function workflowDocTargetChoices() {
  const workflow = fs.readFileSync(
    path.resolve(process.cwd(), '.github/workflows/generate-pdf.yml'),
    'utf8'
  );
  const block = workflow.match(/doc_target:[\s\S]*?options:\n((?:\s+- .+\n)+)/);
  return block[1].trim().split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim());
}

describe('doc target registry', () => {
  test('every alias points at an existing doc-targets file', () => {
    const targets = listDocTargets(targetsDir);
    for (const name of Object.values(DOC_TARGET_ALIASES)) {
      expect(targets).toContain(name);
    }
  });

  test('generate-pdf workflow offers every doc target', () => {
    const choices = workflowDocTargetChoices().map((choice) => DOC_TARGET_ALIASES[choice] || choice);
    for (const name of listDocTargets(targetsDir)) {
      expect(choices, `add ${name} to the generate-pdf.yml doc_target options`).toContain(name);
    }
  });
});
