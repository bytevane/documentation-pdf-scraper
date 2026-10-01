import fs from 'node:fs';
import path from 'node:path';

/**
 * Short names kept for backward compatibility. Every other doc target is
 * addressed by its file name in doc-targets/ (without `.json`).
 */
export const DOC_TARGET_ALIASES = Object.freeze({
  openai: 'openai-docs',
});

/** Names of all doc-targets/*.json files, sorted. */
export function listDocTargets(targetsDir) {
  return fs
    .readdirSync(targetsDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.basename(file, '.json'))
    .sort((a, b) => a.localeCompare(b));
}
