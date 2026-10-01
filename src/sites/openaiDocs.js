import { fromMarkdown } from 'mdast-util-from-markdown';

/**
 * developers.openai.com: Markdown post-processing for its Next.js docs build
 * (wrapped card links, pager navigation, theme-variant screenshot pairs, the
 * Codex models page, ...). Kept out of the generic MarkdownService.
 */
export class OpenAiDocsMarkdown {
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

  /** Markdown produced from the DOM, before sanitizing. */
  normalizeExtractedMarkdown(markdown, { pageUrl, modelSections = [] } = {}) {
    return this._normalizeOpenAiModelsPage(markdown, modelSections, pageUrl);
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
