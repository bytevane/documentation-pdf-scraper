import { OpenAiDocsMarkdown } from './openaiDocs.js';

// Site-specific Markdown handling. A doc target can name one with `siteAdapter`
// ("none" disables them); otherwise every adapter is tried. Either way an adapter
// only applies to pages its matches(pageUrl) accepts.
const SITE_ADAPTERS = [OpenAiDocsMarkdown];

export const SITE_ADAPTER_IDS = Object.freeze(SITE_ADAPTERS.map((Adapter) => Adapter.id));

/**
 * Instantiate the site adapters a config allows, with the helpers they need from MarkdownService.
 * @param {Object} helpers
 * @param {string} [siteAdapter] - adapter id, "none", or undefined for all
 */
export function createSiteAdapters(helpers, siteAdapter) {
  if (siteAdapter === 'none') return [];
  return SITE_ADAPTERS
    .filter((Adapter) => siteAdapter === undefined || Adapter.id === siteAdapter)
    .map((Adapter) => new Adapter(helpers));
}
