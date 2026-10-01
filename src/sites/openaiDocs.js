import { fromMarkdown } from 'mdast-util-from-markdown';

/**
 * Runs in the browser through page.evaluate() on a detached clone of the page's
 * content element, before the generic SVG handling. Puppeteer serializes this
 * function, so it must not reference anything outside its own body.
 *
 * @param {Element|null} clone
 * @param {string} currentPageUrl
 * @returns {{ modelSections: Array<Object> }}
 */
function transformOpenAiContentClone(clone, currentPageUrl) {
  if (!clone) return { modelSections: [] };

  const normalizeWhitespace = (text = '') => text.replace(/\s+/g, ' ').trim();
  const getVisibleText = (element) => {
    const textClone = element.cloneNode(true);
    textClone
      .querySelectorAll(
        'script, style, noscript, template, img, svg, [aria-hidden="true"], [aria-live], .sr-only, [hidden]'
      )
      .forEach((node) => node.remove());

    return normalizeWhitespace(textClone.textContent || '');
  };

  const decodeAstroValue = (value) => {
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number') {
      const [type, payload] = value;

      if (type === 1 && Array.isArray(payload)) {
        return payload.map(decodeAstroValue);
      }

      return decodeAstroValue(payload);
    }

    if (Array.isArray(value)) {
      return value.map(decodeAstroValue);
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, nestedValue]) => [key, decodeAstroValue(nestedValue)])
      );
    }

    return value;
  };

  const parseModelCard = (island) => {
    if (!island) return null;

    let props;
    try {
      props = decodeAstroValue(JSON.parse(island.getAttribute('props') || '{}'));
    } catch {
      props = {};
    }

    const name = normalizeWhitespace(
      props.name
        || island.querySelector('img')?.getAttribute('alt')
        || island.querySelector('.heading-md, .heading-sm, h3, h4')?.textContent
        || ''
    );
    const description = normalizeWhitespace(
      props.description || island.querySelector('p')?.textContent || ''
    );
    const command = normalizeWhitespace(
      island.querySelector('.font-mono')?.textContent || (name ? `codex -m ${name}` : '')
    );
    const features = Array.isArray(props.data?.features)
      ? props.data.features
        .map((feature) => {
          const title = normalizeWhitespace(feature?.title || '');
          if (!title) return null;

          return {
            title,
            value: typeof feature?.value === 'boolean' ? feature.value : normalizeWhitespace(feature?.value || ''),
            iconCount: Array.isArray(feature?.icons) ? feature.icons.length : 0,
          };
        })
        .filter(Boolean)
      : [];

    if (!name && !description && !command && features.length === 0) {
      return null;
    }

    return {
      name,
      description,
      command,
      features,
    };
  };

  const collectModelSections = () => {
    if (!/\/codex\/models\/?$/.test(currentPageUrl || '')) {
      return [];
    }

    const sections = [];
    const sectionHeadings = Array.from(clone.querySelectorAll('h2'));

    sectionHeadings.forEach((heading) => {
      const headingText = normalizeWhitespace(heading.textContent || '');
      if (!['Recommended models', 'Alternative models'].includes(headingText)) {
        return;
      }

      let grid = heading.nextElementSibling;
      while (grid && !grid.querySelector?.('astro-island[component-url*="ModelDetails"]')) {
        if (/^H2$/i.test(grid.tagName)) {
          grid = null;
          break;
        }
        grid = grid.nextElementSibling;
      }

      if (!grid) {
        return;
      }

      const cards = Array.from(
        grid.querySelectorAll('astro-island[component-url*="ModelDetails"]')
      )
        .map(parseModelCard)
        .filter(Boolean);

      if (cards.length === 0) {
        return;
      }

      const notes = [];
      let sibling = grid.nextElementSibling;
      while (sibling && !/^H2$/i.test(sibling.tagName)) {
        const text = getVisibleText(sibling);
        if (text && !sibling.querySelector?.('astro-island[component-url*="ModelDetails"]')) {
          notes.push(text);
        }
        sibling = sibling.nextElementSibling;
      }

      sections.push({
        heading: headingText,
        cards,
        notes,
      });
    });

    return sections;
  };

  const openAiModelSections = collectModelSections();

  clone
    .querySelectorAll(
      'script, noscript, style, template, [data-page-copy-action], .page-copy-action, [data-anchor-id], [data-codex-screenshot-overlay]'
    )
    .forEach((node) => node.remove());

  const normalizePagerLabel = (text = '') => normalizeWhitespace(text).toLowerCase();

  const getPagerLinkInfo = (link) => {
    if (!link) return null;

    const label = normalizePagerLabel(link.textContent || '');
    if (!label) return null;

    const segments = Array.from(link.querySelectorAll('div, span, p, strong, small'))
      .map((node) => normalizePagerLabel(getVisibleText(node)))
      .filter(Boolean);

    const exactSegmentKind = segments.find((segment) => segment === 'previous' || segment === 'next');
    if (exactSegmentKind) {
      return {
        kind: exactSegmentKind,
        exact: true,
        hasTitle: segments.some((segment) => segment !== exactSegmentKind) || label !== exactSegmentKind,
      };
    }

    if (label === 'previous' || label === 'next') {
      return {
        kind: label,
        exact: true,
        hasTitle: false,
      };
    }

    const titledMatch = label.match(/^(previous|next)\s+\S/);
    if (titledMatch) {
      return {
        kind: titledMatch[1],
        exact: false,
        hasTitle: true,
      };
    }

    return null;
  };

  const shouldStripPagerLinks = (linkInfos, { requireExact = false } = {}) => {
    if (!Array.isArray(linkInfos) || linkInfos.length === 0 || linkInfos.length > 2) {
      return false;
    }

    if (linkInfos.some((info) => !info)) {
      return false;
    }

    if (requireExact && linkInfos.some((info) => !info.exact)) {
      return false;
    }

    const hasPrevious = linkInfos.some((info) => info.kind === 'previous');
    const hasNext = linkInfos.some((info) => info.kind === 'next');

    if (hasPrevious && hasNext) {
      return true;
    }

    if (linkInfos.length === 1) {
      return linkInfos[0].exact && !linkInfos[0].hasTitle;
    }

    return false;
  };

  clone.querySelectorAll('nav').forEach((nav) => {
    const linkInfos = Array.from(nav.querySelectorAll('a')).map(getPagerLinkInfo);
    const isPagerNav = shouldStripPagerLinks(linkInfos, { requireExact: true });

    if (isPagerNav) {
      nav.remove();
    }
  });

  const normalizePanelLabel = (label) => {
    if (!label) return '';

    const lower = label.toLowerCase();
    if (lower === 'app') return 'App (Recommended)';
    if (lower === 'ide') return 'IDE extension';
    if (lower === 'cli') return 'CLI';
    if (lower === 'cloud') return 'Cloud';

    return label;
  };

  const tabPanels = Array.from(clone.querySelectorAll('[data-panel][role="region"], [role="tabpanel"]'));
  const tabLists = Array.from(clone.querySelectorAll('[role="tablist"]'));

  tabLists.forEach((tabList) => {
    if (tabPanels.length === 0) {
      const labels = Array.from(tabList.querySelectorAll('[role="tab"], button'))
        .map((button) => normalizePanelLabel(getVisibleText(button)))
        .filter(Boolean);

      if (labels.length > 1 && tabList.parentNode) {
        const list = document.createElement('ul');
        labels.forEach((label) => {
          const item = document.createElement('li');
          item.textContent = label;
          list.appendChild(item);
        });
        tabList.parentNode.insertBefore(list, tabList);
      }
    }

    tabList.remove();
  });

  if (tabPanels.length > 0) {
    tabPanels.forEach((panel) => {
      panel.removeAttribute('hidden');
      panel.setAttribute('aria-hidden', 'false');

      const label = normalizePanelLabel(
        normalizeWhitespace(panel.getAttribute('aria-label') || panel.getAttribute('data-panel') || '')
      );

      if (!label || !panel.parentNode) {
        return;
      }

      const previousElement = panel.previousElementSibling;
      if (
        previousElement &&
        /^H[1-6]$/.test(previousElement.tagName) &&
        normalizeWhitespace(previousElement.textContent || '') === label
      ) {
        return;
      }

      const heading = document.createElement('h3');
      heading.textContent = label;
      panel.parentNode.insertBefore(heading, panel);
    });
  }

  clone.querySelectorAll('[data-codex-screenshot-root]').forEach((root) => {
    const inlineImage =
      root.querySelector('img[data-codex-screenshot-inline-image]') ||
      Array.from(root.querySelectorAll('img')).find(
        (image) => !image.closest('[data-codex-screenshot-overlay]')
      );

    if (!inlineImage) {
      root.remove();
      return;
    }

    const figure = document.createElement('figure');
    const imageClone = inlineImage.cloneNode(true);
    imageClone.removeAttribute('style');
    imageClone.removeAttribute('class');
    figure.appendChild(imageClone);
    root.replaceWith(figure);
  });

  clone.querySelectorAll('button').forEach((button) => {
    const label = button.getAttribute('aria-label') || '';
    const text = getVisibleText(button);
    const copiedBadge = Array.from(button.querySelectorAll('[aria-hidden="true"]')).some((node) =>
      /copied/i.test(node.textContent || '')
    );
    const hasExampleIcon = !!button.querySelector('img[src*="/codex/colorcons/"]');

    if (copiedBadge || hasExampleIcon) {
      if (!text) {
        button.remove();
        return;
      }

      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      button.replaceWith(paragraph);
      return;
    }

    if (!text || /copy|close|open/i.test(label)) {
      button.remove();
    }
  });

  return { modelSections: openAiModelSections };
}

/**
 * developers.openai.com: Markdown post-processing for its Next.js docs build
 * (wrapped card links, pager navigation, theme-variant screenshot pairs, the
 * Codex models page, ...). Kept out of the generic MarkdownService.
 */
export class OpenAiDocsMarkdown {
  static id = 'openai-docs';

  /** Browser-side DOM step; see transformOpenAiContentClone. */
  static transformContentClone = transformOpenAiContentClone;

  /**
   * @param {{ resolveResourceUrl: (target: string, pageUrl: string) => string }} helpers
   */
  constructor({ resolveResourceUrl }) {
    this._resolveResourceUrl = resolveResourceUrl;
  }

  static matches(pageUrl) {
    if (!pageUrl) return false;
    try {
      return new URL(pageUrl).hostname === 'developers.openai.com';
    } catch {
      return false;
    }
  }

  /** Markdown produced from the DOM, before sanitizing; siteData comes from transformContentClone. */
  normalizeExtractedMarkdown(markdown, { pageUrl, siteData = {} } = {}) {
    return this._normalizeOpenAiModelsPage(markdown, siteData.modelSections || [], pageUrl);
  }

  /** Site-specific cleanup run by MarkdownService.sanitizeMarkdown. */
  postProcessMarkdown(markdown, pageUrl) {
    let result = markdown;
    result = result.replace(/^\s*Copy Page\s*$/gim, '');
    result = result.replace(/^\s*Copied\s*$/gim, '');
    result = this._normalizeOpenAiWrappedCardLinks(result, pageUrl);
    result = this._normalizeOpenAiExampleTaskCards(result);
    result = this._stripOpenAiPagerNavigation(result);
    result = this._normalizeOpenAiQuickstartTabSummary(result);
    result = this._normalizeOpenAiCliSetupCards(result, pageUrl);
    result = this._collapseOpenAiThemeVariantPairs(result);
    result = this._simplifyOpenAiUseCasesIndex(result, pageUrl);
    return result;
  }

  /**
   * 将 Codex Models 页里被扁平化的模型卡片重建为紧凑、适合 PDF 的 Markdown。
   *
   * @param {string} markdown
   * @param {Array<{ heading: string, cards: Array<Object>, notes?: string[] }>} modelSections
   * @param {string} pageUrl
   * @returns {string}
   * @private
   */
  _normalizeOpenAiModelsPage(markdown, modelSections = [], pageUrl = '') {
    if (!markdown || !/\/codex\/models\/?$/.test(pageUrl) || !Array.isArray(modelSections) || modelSections.length === 0) {
      return markdown;
    }

    const iconScaleByTitle = {};
    for (const section of modelSections) {
      for (const card of section.cards || []) {
        for (const feature of card.features || []) {
          if (!feature?.title || !feature.iconCount) {
            continue;
          }

          iconScaleByTitle[feature.title] = Math.max(
            iconScaleByTitle[feature.title] || 0,
            feature.iconCount
          );
        }
      }
    }

    const wrapKnownModelNames = (text) => {
      if (!text) return text;
      return text.replace(/\b(gpt-\d+(?:\.\d+)?(?:-[a-z0-9]+)*)\b/gi, '`$1`');
    };

    const formatFeature = (feature) => {
      if (!feature?.title) return '';

      if (typeof feature.value === 'boolean') {
        return `- ${feature.title}: ${feature.value ? 'Yes' : 'No'}`;
      }

      if (typeof feature.value === 'string' && feature.value.trim()) {
        return `- ${feature.title}: ${feature.value.trim()}`;
      }

      if (feature.iconCount) {
        const max = iconScaleByTitle[feature.title] || feature.iconCount;
        return `- ${feature.title}: ${feature.iconCount}/${max}`;
      }

      return `- ${feature.title}`;
    };

    const formatCard = (card) => {
      if (!card?.name) return '';

      const parts = [`### ${card.name}`];

      if (card.description) {
        parts.push('', card.description);
      }

      if (card.command) {
        parts.push('', '```bash', card.command, '```');
      }

      const featureLines = (card.features || []).map(formatFeature).filter(Boolean);
      if (featureLines.length > 0) {
        parts.push('', featureLines.join('\n'));
      }

      return parts.join('\n');
    };

    const escapeHeading = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    let normalized = markdown;
    for (let index = 0; index < modelSections.length; index += 1) {
      const section = modelSections[index];
      if (!section?.heading || !Array.isArray(section.cards) || section.cards.length === 0) {
        continue;
      }

      const nextHeading = modelSections[index + 1]?.heading || 'Other models';
      const sectionBody = section.cards
        .map(formatCard)
        .filter(Boolean)
        .join('\n\n');
      const noteBody = (section.notes || [])
        .map((note) => wrapKnownModelNames(note))
        .filter(Boolean)
        .join('\n\n');
      const replacement = [sectionBody, noteBody].filter(Boolean).join('\n\n');

      if (!replacement) {
        continue;
      }

      const pattern = new RegExp(
        `(## ${escapeHeading(section.heading)}\\n\\n)([\\s\\S]*?)(?=\\n## ${escapeHeading(nextHeading)}\\n|$)`
      );

      normalized = normalized.replace(pattern, `$1${replacement}\n\n`);
    }

    return normalized;
  }


  /**
   * 修复 OpenAI 页面中“整块卡片是链接”被 Turndown 打碎后的 Markdown。
   *
   * @param {string} markdown
   * @param {string} pageUrl
   * @returns {string}
   * @private
   */
  _normalizeOpenAiWrappedCardLinks(markdown, pageUrl = '') {
    if (!markdown) return markdown;

    let normalized = markdown;

    normalized = normalized.replace(/^\s*\[\]\([^)]+\)\s*$/gm, '');

    normalized = normalized.replace(
      /\[\s*((?:!\[[^\]]*]\([^)]*\)\s*)+)\n*(#{1,6}\s+[^\n]+)\n+([\s\S]*?)(?:\n+\]\(([^)\n]+)\)|\]\(([^)\n]+)\))(?=\s*(?:\n|$|\[))/g,
      (match, images, heading, body, lineBreakUrl, inlineUrl) => {
        const resolvedUrl = this._resolveResourceUrl((lineBreakUrl || inlineUrl || '').trim(), pageUrl);
        const normalizedImages = images.trim();
        const normalizedBody = body.trim();
        const headingMatch = heading.trim().match(/^(#{1,6})\s+(.+)$/);

        if (!normalizedImages || !normalizedBody || !headingMatch || !resolvedUrl) {
          return match;
        }

        const [, hashes, headingText] = headingMatch;
        const linkedHeading = `${hashes} [${headingText.trim()}](${resolvedUrl})`;

        return [normalizedImages, '', linkedHeading, '', normalizedBody, '', ''].join('\n');
      }
    );

    normalized = normalized.replace(
      /\[\s*((?:!\[[^\]]*]\([^)]*\)\s*)+)\n*([^\n#![][^)\n]*)\n+([\s\S]*?)(?:\n+\]\(([^)\n]+)\)|\]\(([^)\n]+)\))(?=\s*(?:\n|$|\[))/g,
      (match, images, title, body, lineBreakUrl, inlineUrl) => {
        const resolvedUrl = this._resolveResourceUrl((lineBreakUrl || inlineUrl || '').trim(), pageUrl);
        const normalizedImages = images.trim();
        const normalizedTitle = title.trim();
        const normalizedBody = body.trim();

        if (!normalizedImages || !normalizedTitle || !normalizedBody || !resolvedUrl) {
          return match;
        }

        return [
          normalizedImages,
          '',
          `### [${normalizedTitle}](${resolvedUrl})`,
          '',
          normalizedBody,
          '',
          '',
        ].join('\n');
      }
    );

    normalized = normalized.replace(
      /\[\s*\n+(#{1,6}\s+[^\n]+)\n+([\s\S]*?)\n+\]\(([^)\n]+)\)(?=\s*(?:\n|$|\[))/g,
      (match, heading, body, url) => {
        const headingMatch = heading.trim().match(/^(#{1,6})\s+(.+)$/);
        const normalizedBody = body.trim();
        const normalizedUrl = this._resolveResourceUrl(url.trim(), pageUrl);

        if (!headingMatch || !normalizedBody || !normalizedUrl) {
          return match;
        }

        const [, hashes, headingText] = headingMatch;
        const linkedHeading = `${hashes} [${headingText.trim()}](${normalizedUrl})`;

        return [linkedHeading, '', normalizedBody, '', ''].join('\n');
      }
    );

    normalized = normalized.replace(
      /\[\s*\n+(#{1,6}\s+[^\n]+)\n+([\s\S]*?)\n+([^\]\n]+)\]\(([^)\n]+)\)(?=\s*(?:\n|$|\[))/g,
      (match, heading, body, label, url) => {
        const normalizedHeading = heading.trim();
        const normalizedBody = body.trim();
        const normalizedLabel = label.trim();
        const normalizedUrl = this._resolveResourceUrl(url.trim(), pageUrl);

        if (!normalizedHeading || !normalizedBody || !normalizedLabel || !normalizedUrl) {
          return match;
        }

        return [
          normalizedHeading,
          '',
          normalizedBody,
          '',
          `[${normalizedLabel}](${normalizedUrl})`,
          '',
          '',
        ].join('\n');
      }
    );

    normalized = normalized.replace(
      /(\[[^\]\n]+]\([^)]+\))(?=\[[^\]\n]+]\([^)]+\))/g,
      '$1\n'
    );

    normalized = normalized.replace(/^\[([^\n\]]+\[[^\]]+]\([^)]+\)[^\n]*)$/gm, '$1');

    return normalized;
  }

  /**
   * 将 OpenAI 文档里的示例 prompt 卡片还原为普通项目符号列表。
   *
   * @param {string} markdown
   * @returns {string}
   * @private
   */
  _normalizeOpenAiExampleTaskCards(markdown) {
    if (!markdown) return markdown;

    return markdown.replace(
      /(?:!\[[^\]]*]\([^)]*\)\s*[^!\n]+?\s*Copied\s*)+/g,
      (match) => {
        const prompts = Array.from(
          match.matchAll(/!\[[^\]]*]\([^)]*\)\s*([^!\n]+?)\s*Copied/gi),
          (entry) => entry[1].trim()
        ).filter(Boolean);

        if (prompts.length === 0) {
          return match;
        }

        return prompts.map((prompt) => `- ${prompt}`).join('\n');
      }
    );
  }

  /**
   * 移除 OpenAI 文档底部的上一页/下一页导航块。
   *
   * @param {string} markdown
   * @returns {string}
   * @private
   */
  _stripOpenAiPagerNavigation(markdown) {
    if (!markdown) return markdown;

    const strippedByAst = this._stripOpenAiPagerNavigationWithAst(markdown);
    if (strippedByAst !== markdown) {
      return strippedByAst;
    }

    const strippedPair = markdown.replace(
      /\[\s*Previous(?:\s|\n)[\s\S]*?]\([^)]+\)\s*\[\s*Next(?:\s|\n)[\s\S]*?]\([^)]+\)\s*$/,
      ''
    );

    return strippedPair.replace(/(^|\n)\[\s*([\s\S]*?)\]\([^)]+\)\s*$/, (match, prefix, label) => {
      const labelLines = String(label)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      if (labelLines.length === 0) {
        return match;
      }

      const firstLine = labelLines[0].toLowerCase();
      if (firstLine === 'previous' || firstLine === 'next') {
        return prefix;
      }

      return match;
    });
  }

  /**
   * 使用 Markdown AST 识别尾部 pager，避免误删正文中的方括号快捷键或普通链接。
   *
   * @param {string} markdown
   * @returns {string}
   * @private
   */
  _stripOpenAiPagerNavigationWithAst(markdown) {
    try {
      const tree = fromMarkdown(markdown);
      const trailingPagerNodes = [];
      const trailingPagerLinkInfos = [];

      for (let index = tree.children.length - 1; index >= 0; index -= 1) {
        const node = tree.children[index];
        const pagerInfo = this._getOpenAiPagerNodeInfo(node);

        if (!pagerInfo) {
          break;
        }

        trailingPagerNodes.unshift(node);
        trailingPagerLinkInfos.unshift(...pagerInfo.linkInfos);
      }

      if (trailingPagerNodes.length === 0) {
        return markdown;
      }

      if (!this._shouldStripOpenAiPagerLinkGroup(trailingPagerLinkInfos)) {
        return markdown;
      }

      const startOffset = trailingPagerNodes[0]?.position?.start?.offset;
      if (typeof startOffset !== 'number') {
        return markdown;
      }

      return markdown.slice(0, startOffset).replace(/\s*$/, '');
    } catch {
      return markdown;
    }
  }

  /**
   * 提取段落节点中的 pager 链接信息。
   *
   * @param {import('mdast').Content} node
   * @returns {{linkInfos: Array<{kind: 'previous'|'next', exact: boolean, hasTitle: boolean}>}|null}
   * @private
   */
  _getOpenAiPagerNodeInfo(node) {
    if (!node || node.type !== 'paragraph' || !Array.isArray(node.children)) {
      return null;
    }

    const linkChildren = [];

    for (const child of node.children) {
      if (child.type === 'text' && !(child.value || '').trim()) {
        continue;
      }

      if (child.type !== 'link') {
        return null;
      }

      linkChildren.push(child);
    }

    if (linkChildren.length === 0 || linkChildren.length > 2) {
      return null;
    }

    const linkInfos = linkChildren.map((child) =>
      this._getOpenAiPagerLinkInfo(this._extractMdastText(child))
    );

    if (linkInfos.some((info) => !info)) {
      return null;
    }

    return { linkInfos };
  }

  /**
   * 将 mdast 节点中的纯文本拼接出来。
   *
   * @param {Object} node
   * @returns {string}
   * @private
   */
  _extractMdastText(node) {
    if (!node) {
      return '';
    }

    if (typeof node.value === 'string') {
      return node.value;
    }

    if (!Array.isArray(node.children)) {
      return '';
    }

    return node.children.map((child) => this._extractMdastText(child)).join('');
  }

  /**
   * 规范化 pager 标签，便于跨 DOM / Markdown AST 共享判断逻辑。
   *
   * @param {string} label
   * @returns {string}
   * @private
   */
  _normalizeOpenAiPagerLabel(label) {
    return String(label || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * 提取单个 pager 链接的方向与“是否显式 pager 控件”信息。
   *
   * @param {string} label
   * @param {string[]} [segments]
   * @returns {{kind: 'previous'|'next', exact: boolean, hasTitle: boolean}|null}
   * @private
   */
  _getOpenAiPagerLinkInfo(label, segments = []) {
    const normalized = this._normalizeOpenAiPagerLabel(label);
    const normalizedSegments = segments
      .map((segment) => this._normalizeOpenAiPagerLabel(segment))
      .filter(Boolean);

    const exactSegmentKind = normalizedSegments.find(
      (segment) => segment === 'previous' || segment === 'next'
    );

    if (exactSegmentKind) {
      return {
        kind: exactSegmentKind,
        exact: true,
        hasTitle: normalizedSegments.some((segment) => segment !== exactSegmentKind) || normalized !== exactSegmentKind,
      };
    }

    if (normalized === 'previous' || normalized === 'next') {
      return {
        kind: normalized,
        exact: true,
        hasTitle: false,
      };
    }

    const titledMatch = normalized.match(/^(previous|next)\s+\S/);
    if (titledMatch) {
      return {
        kind: titledMatch[1],
        exact: false,
        hasTitle: true,
      };
    }

    return null;
  }

  /**
   * 判断一组 pager 链接是否足够明确，可以安全地当作页尾 pager 删除。
   *
   * @param {Array<{kind: 'previous'|'next', exact: boolean, hasTitle: boolean}>} linkInfos
   * @param {{requireExact?: boolean}} [options]
   * @returns {boolean}
   * @private
   */
  _shouldStripOpenAiPagerLinkGroup(linkInfos, options = {}) {
    const { requireExact = false } = options;

    if (!Array.isArray(linkInfos) || linkInfos.length === 0 || linkInfos.length > 2) {
      return false;
    }

    if (linkInfos.some((info) => !info)) {
      return false;
    }

    if (requireExact && linkInfos.some((info) => !info.exact)) {
      return false;
    }

    const hasPrevious = linkInfos.some((info) => info.kind === 'previous');
    const hasNext = linkInfos.some((info) => info.kind === 'next');

    if (hasPrevious && hasNext) {
      return true;
    }

    if (linkInfos.length === 1) {
      return linkInfos[0].exact && !linkInfos[0].hasTitle;
    }

    return false;
  }

  /**
   * 兜底清理 Quickstart 页签按钮串成一行的残留文本。
   *
   * @param {string} markdown
   * @returns {string}
   * @private
   */
  _normalizeOpenAiQuickstartTabSummary(markdown) {
    if (!markdown) return markdown;

    return markdown.replace(
      /^AppRecommendedIDE extensionCodex in your IDECLICodex in your terminalCloudCodex in your browser$/m,
      ['- App (Recommended)', '- IDE extension', '- CLI', '- Cloud'].join('\n')
    );
  }

  /**
   * 清理 Codex CLI 首页中由步骤卡片转换出来的重复数字与冗余标签。
   *
   * @param {string} markdown
   * @param {string} pageUrl
   * @returns {string}
   * @private
   */
  _normalizeOpenAiCliSetupCards(markdown, pageUrl = '') {
    if (!markdown || !/\/codex\/cli\/?$/.test(pageUrl)) {
      return markdown;
    }

    return markdown
      .replace(/^(\d+)\.\s+\1\s*$/gm, '$1.')
      .replace(/^\s*[A-Za-z][A-Za-z\s]+ command\s*$/gm, '');
  }

  /**
   * 精简 Codex use-cases 首页里的筛选按钮与装饰性大图，避免目录页在 PDF 中被图片撑成多页。
   *
   * @param {string} markdown
   * @param {string} pageUrl
   * @returns {string}
   * @private
   */
  _simplifyOpenAiUseCasesIndex(markdown, pageUrl = '') {
    if (!markdown || !/\/codex\/use-cases\/?$/.test(pageUrl)) {
      return markdown;
    }

    return markdown
      .replace(
        /^\[(?:[^\]]+)]\([^)]*\?search=[^)]+\)(?:\s+\[(?:[^\]]+)]\([^)]*\?search=[^)]+\))*\s*$/gm,
        ''
      )
      .replace(
        /^(?:#{1,6}\s+)?No use cases match these filters\s*\n+Try clearing a few filters or searching for a broader term\.\s*$/m,
        ''
      )
      .replace(/^\s*(?:!\[[^\]]*]\([^)]+\)\s*)+\s*$/gm, '');
  }

  /**
   * 将 OpenAI 文档中相邻的浅色/深色主题截图收敛为单张截图，避免在 PDF 中拼成超宽图片。
   *
   * @param {string} markdown
   * @returns {string}
   * @private
   */
  _collapseOpenAiThemeVariantPairs(markdown) {
    if (!markdown) return markdown;

    const imagePattern = /!\[([^\]]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g;

    return markdown.replace(
      /!\[[^\]]*]\([^)]+\)\s*!\[[^\]]*]\([^)]+\)/g,
      (match) => {
        const images = Array.from(match.matchAll(imagePattern), (entry) => ({
          raw: entry[0],
          alt: entry[1] || '',
          target: entry[2] || '',
        }));

        if (images.length < 2) {
          return match;
        }

        const [first, second] = images;
        if (!this._isOpenAiThemeVariantPair(first, second)) {
          return match;
        }

        const preferred = images.find((image) => /(?:^|[-_/])(light)(?:[-_.]|$)/i.test(image.target))
          || first;

        const cleanedAlt = preferred.alt
          .replace(/\s*\((?:light|dark) mode\)\s*/gi, '')
          .trim();

        return `![${cleanedAlt}](${preferred.target})`;
      }
    );
  }

  /**
   * 判断两张图片是否仅为浅色/深色主题变体。
   *
   * @param {{ alt: string, target: string }} first
   * @param {{ alt: string, target: string }} second
   * @returns {boolean}
   * @private
   */
  _isOpenAiThemeVariantPair(first, second) {
    if (!first || !second) {
      return false;
    }

    const normalizeAlt = (alt) => alt
      .replace(/\s*\((?:light|dark) mode\)\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    const normalizeTarget = (target) => {
      const trimmed = (target || '').trim();
      const [urlPart] = trimmed.split(/\s+"/, 1);

      try {
        const url = new URL(urlPart);
        return url.pathname
          .replace(/-(?:light|dark)(?=\.[a-z0-9]+$)/i, '')
          .replace(/\.[a-z0-9]+$/i, '')
          .toLowerCase();
      } catch {
        return urlPart
          .replace(/-(?:light|dark)(?=\.[a-z0-9]+$)/i, '')
          .replace(/\.[a-z0-9]+$/i, '')
          .toLowerCase();
      }
    };

    const firstAlt = normalizeAlt(first.alt);
    const secondAlt = normalizeAlt(second.alt);
    const firstTarget = normalizeTarget(first.target);
    const secondTarget = normalizeTarget(second.target);

    if (!firstTarget || !secondTarget || firstTarget !== secondTarget) {
      return false;
    }

    return firstAlt === secondAlt || !firstAlt || !secondAlt;
  }
}
