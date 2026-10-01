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
