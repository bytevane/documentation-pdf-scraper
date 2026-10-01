import { OpenAiDocsMarkdown } from './openaiDocs.js';

// Site-specific Markdown handling, selected by page URL.
const SITE_ADAPTERS = [OpenAiDocsMarkdown];

/** Instantiate every site adapter with the helpers it needs from MarkdownService. */
export function createSiteAdapters(helpers) {
  return SITE_ADAPTERS.map((Adapter) => new Adapter(helpers));
}
