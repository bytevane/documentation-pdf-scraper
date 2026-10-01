import { describe, expect, test } from 'vitest';
import { OpenAiDocsMarkdown } from '../../src/sites/openaiDocs.js';
import { MarkdownService } from '../../src/services/markdownService.js';

describe('OpenAiDocsMarkdown', () => {
  test('matches only developers.openai.com pages', () => {
    expect(OpenAiDocsMarkdown.matches('https://developers.openai.com/codex')).toBe(true);
    expect(OpenAiDocsMarkdown.matches('https://code.claude.com/docs/en/overview')).toBe(false);
    expect(OpenAiDocsMarkdown.matches('not a url')).toBe(false);
    expect(OpenAiDocsMarkdown.matches(undefined)).toBe(false);
  });

  test('MarkdownService applies OpenAI cleanup only on OpenAI pages', () => {
    const service = new MarkdownService({ logger: { debug() {}, info() {}, warn() {} } });
    const markdown = '# Title\n\nCopy Page\n\nBody text.';

    expect(service.sanitizeMarkdown(markdown, { pageUrl: 'https://developers.openai.com/codex' }))
      .not.toContain('Copy Page');
    expect(service.sanitizeMarkdown(markdown, { pageUrl: 'https://example.com/docs' }))
      .toContain('Copy Page');
  });
});

describe('siteAdapter config', () => {
  const pageUrl = 'https://developers.openai.com/codex';
  const markdown = '# Title\n\nCopy Page\n\nBody text.';
  const createService = (config) =>
    new MarkdownService({ config, logger: { debug() {}, info() {}, warn() {} } });

  test('a named adapter still only applies to pages it matches', () => {
    const service = createService({ siteAdapter: 'openai-docs' });

    expect(service.sanitizeMarkdown(markdown, { pageUrl })).not.toContain('Copy Page');
    expect(service.sanitizeMarkdown(markdown, { pageUrl: 'https://platform.openai.com/docs' }))
      .toContain('Copy Page');
  });

  test('"none" turns site rules off', () => {
    const service = createService({ siteAdapter: 'none' });

    expect(service.sanitizeMarkdown(markdown, { pageUrl })).toContain('Copy Page');
  });

  test('the schema accepts known adapter ids and "none" only', async () => {
    const { validatePartialConfig } = await import('../../src/config/configValidator.js');
    const isValid = (siteAdapter) => validatePartialConfig({ siteAdapter }).valid;

    expect(isValid('openai-docs')).toBe(true);
    expect(isValid('none')).toBe(true);
    expect(isValid('unknown-site')).toBe(false);
  });

  test('the OpenAI doc target declares its adapter', async () => {
    const fs = await import('node:fs');
    const target = JSON.parse(fs.readFileSync('doc-targets/openai-docs.json', 'utf8'));

    expect(target.siteAdapter).toBe('openai-docs');
  });
});
