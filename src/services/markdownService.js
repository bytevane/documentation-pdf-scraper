import { mapMarkdownProse } from '../utils/markdownSegments.js';
// src/services/markdownService.js
import { createSiteAdapters } from '../sites/index.js';
import TurndownService from 'turndown';

/**
 * MarkdownService
 * - 将 HTML 内容转换为 Markdown
 * - 从 Puppeteer 页面提取内容并预处理（例如 SVG）
 * - 处理 YAML frontmatter 的添加与解析
 */
/**
 * Runs in the browser through page.evaluate(): wraps labelled SVGs in figures
 * and returns the clone's HTML. Must stay self-contained (it is serialized).
 *
 * @param {Element|null} clone
 * @returns {{ html: string, svgCount: number }}
 */
function serializeContentClone(clone) {
  if (!clone) return { html: '', svgCount: 0 };

  const svgs = clone.querySelectorAll('svg');

  svgs.forEach((svg) => {
    try {
      const texts = [];

      const titleEl = svg.querySelector('title');
      if (titleEl && titleEl.textContent) {
        texts.push(titleEl.textContent.trim());
      }

      const descEl = svg.querySelector('desc');
      if (descEl && descEl.textContent) {
        texts.push(descEl.textContent.trim());
      }

      const textNodes = Array.from(svg.querySelectorAll('text'))
        .map((node) => node.textContent || '')
        .map((t) => t.trim())
        .filter((t) => t && !/^[\d\s.,%-]+$/.test(t)); // 过滤纯数字刻度

      texts.push(...textNodes);

      if (texts.length > 0) {
        const figure = document.createElement('figure');
        const caption = document.createElement('figcaption');
        caption.textContent = texts.join(' | ');

        svg.parentNode.insertBefore(figure, svg);
        figure.appendChild(svg);
        figure.appendChild(caption);
      }
    } catch {
      // SVG 处理失败不应该阻塞整体流程
      // 这里不在浏览器环境里打印日志，交给外层处理
    }
  });

  return { html: clone.innerHTML, svgCount: svgs.length };
}

export class MarkdownService {
  constructor(options = {}) {
    this.logger = options.logger;
    this.config = options.config || {};
    this.markdownConfig = this.config.markdown || options.markdown || {};
    this.siteAdapters = createSiteAdapters({
      resolveResourceUrl: (target, pageUrl) => this._resolveResourceUrl(target, pageUrl),
    });

    const turndownOptions = {
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      ...options.turndownOptions,
    };

    this.turndown = new TurndownService(turndownOptions);

    // 剥离非正文且可能污染 LaTeX 的元素。
    // 背景：某些站点（例如 developers.openai.com 的 Next.js 构建）会把
    // 压缩后的 JavaScript 直接嵌入正文容器内的 <script> 标签，其中裸露的
    // `&` 字符会让 Pandoc → XeLaTeX 以 `Misplaced alignment tab character &.`
    // 报错并中止 PDF 生成。CSS 字面量同理。统一在此剥离，使 Markdown 工作流
    // 无需依赖 pdfStyleService（后者仅在 enablePDFStyleProcessing=true 时生效）。
    this.turndown.remove(['script', 'noscript', 'style', 'template']);

    // 使用 `*text*` 而不是 `_text_` 来表示 HTML <em>/<i> 强调，
    // 这样生成的 Markdown 更符合 Pandoc / CommonMark 对“词内部强调优先使用 *”的最佳实践，
    // 避免在中英文混排场景下由下划线强调带来的歧义。
    this.turndown.addRule('emphasis', {
      filter: ['em', 'i'],
      replacement: (content) => {
        if (!content) return '';
        return `*${content}*`;
      },
    });

    // 使用 `**text**` 而不是 `__text__` 表示 HTML <strong>/<b> 的粗体，
    // 统一 strong 风格，便于在 Pandoc / CommonMark 中与 * / ** 规则配合使用。
    this.turndown.addRule('strong', {
      filter: ['strong', 'b'],
      replacement: (content) => {
        if (!content) return '';
        return `**${content}**`;
      },
    });

    // 使用 `~~text~~` 表示删除线，将 HTML <del>/<s>/<strike> 统一为 GFM/Pandoc
    // 常用的删除风格，便于在 Markdown → PDF 流水线中得到一致展示。
    this.turndown.addRule('strikethrough', {
      filter: ['del', 's', 'strike'],
      replacement: (content) => {
        if (!content) return '';
        return `~~${content}~~`;
      },
    });

    // 将 <kbd> 统一为行内代码，便于在 PDF 中保持快捷键的视觉边界。
    this.turndown.addRule('keyboardKey', {
      filter: ['kbd'],
      replacement: (content) => this._wrapInlineCode(content),
    });

    // Turndown 默认不会把 HTML table 转成可读的 Markdown 表格。
    // 对 OpenAI/Codex 这类大量使用 reference tables 的页面，保留表格结构
    // 比事后对顺序文本做猜测性修补更可靠。
    this.turndown.addRule('markdownTable', {
      filter: ['table'],
      replacement: (_content, node) => {
        const markdownTable = this._convertTableToMarkdown(node);
        return markdownTable ? `\n\n${markdownTable}\n\n` : '\n\n';
      },
    });

    // 保留代码块语言标识（```js``` 等）
    this.turndown.addRule('fencedCodeBlockWithLanguage', {
      filter: (node) => {
        return node.nodeName === 'PRE' && node.firstChild && node.firstChild.nodeName === 'CODE';
      },
      replacement: (content, node) => {
        const codeElement = node.firstChild;
        const className = codeElement.className || '';

        const langMatch = className.match(/language-([\w-]+)/) || className.match(/lang-([\w-]+)/);

        const lang = langMatch ? langMatch[1] : '';
        const code = codeElement.textContent || '';

        const fence = '```';
        const langSuffix = lang ? `${lang}` : '';

        return `\n${fence}${langSuffix}\n${code.replace(/\n$/, '')}\n${fence}\n`;
      },
    });
  }

  /**
   * 将相对资源 URL 规范化为绝对 URL，避免 Pandoc 在 PDF 阶段把站点内资源
   * 误当成本地文件路径处理（例如 `/images/...`）。
   *
   * @param {string} markdown
   * @param {string} pageUrl
   * @returns {string}
   */
  normalizeResourceUrls(markdown, pageUrl) {
    if (!markdown || typeof markdown !== 'string' || !pageUrl) {
      return markdown;
    }

    return mapMarkdownProse(markdown, (segment) => this._normalizeProseUrls(segment, pageUrl), { inlineCode: true });
  }

  _normalizeProseUrls(markdown, pageUrl) {
    let normalized = markdown;

    // Markdown links/images: ![alt](/img.png) / [text](/guide)
    normalized = normalized.replace(
      /(!?\[[^\]]*]\(\s*)(<)?((?:\/{1,2}|\.{1,2}\/)[^)\s>]+(?:\?[^)\s>]*)?(?:#[^)\s>]*)?)(>)?((?:\s+["'][^"']*["'])?\s*\))/g,
      (match, prefix, openBracket = '', target, closeBracket = '', suffix) => {
        const resolved = this._resolveResourceUrl(target, pageUrl);
        return resolved ? `${prefix}${openBracket}${resolved}${closeBracket}${suffix}` : match;
      }
    );

    // Raw HTML img/a tags embedded in markdown.
    normalized = normalized.replace(
      /(<(?:img|a)\b[^>]*?\b(?:src|href)=["'])([^"']+)(["'][^>]*>)/gi,
      (match, prefix, target, suffix) => {
        const resolved = this._resolveResourceUrl(target, pageUrl);
        return resolved ? `${prefix}${resolved}${suffix}` : match;
      }
    );

    // Raw HTML source tags with srcset, e.g. <source srcset="/foo.webp 1x, /bar.webp 2x">
    normalized = normalized.replace(
      /(<source\b[^>]*?\bsrcset=["'])([^"']+)(["'][^>]*>)/gi,
      (match, prefix, srcset, suffix) => {
        const resolved = this._resolveSrcset(srcset, pageUrl);
        return resolved ? `${prefix}${resolved}${suffix}` : match;
      }
    );

    return normalized;
  }

  /**
   * 将单个相对 URL 解析为绝对 URL。
   *
   * @param {string} target
   * @param {string} pageUrl
   * @returns {string}
   * @private
   */
  _siteAdapterFor(pageUrl) {
    return this.siteAdapters.find((adapter) => adapter.constructor.matches(pageUrl)) || null;
  }

  _resolveResourceUrl(target, pageUrl) {
    if (!target || typeof target !== 'string' || !pageUrl) {
      return target;
    }

    const trimmed = target.trim();
    if (!trimmed) return target;

    // 已经是绝对 URL、锚点、内联数据或非网页协议时不处理。
    if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(trimmed)) {
      return trimmed;
    }

    const isRelativePath =
      trimmed.startsWith('/') ||
      trimmed.startsWith('./') ||
      trimmed.startsWith('../') ||
      trimmed.startsWith('//');

    if (!isRelativePath) {
      return trimmed;
    }

    try {
      return new URL(trimmed, pageUrl).toString();
    } catch (error) {
      this.logger?.debug?.('资源 URL 规范化失败，保留原值', {
        pageUrl,
        target: trimmed,
        error: error.message,
      });
      return trimmed;
    }
  }

  /**
   * 解析 srcset 中的多个资源 URL。
   *
   * @param {string} srcset
   * @param {string} pageUrl
   * @returns {string}
   * @private
   */
  _resolveSrcset(srcset, pageUrl) {
    if (!srcset || typeof srcset !== 'string') {
      return srcset;
    }

    return srcset
      .split(',')
      .map((entry) => {
        const trimmed = entry.trim();
        if (!trimmed) return trimmed;

        const [target, ...descriptors] = trimmed.split(/\s+/);
        const resolved = this._resolveResourceUrl(target, pageUrl);

        return [resolved, ...descriptors].join(' ').trim();
      })
      .join(', ');
  }

  /**
   * 将文本包裹为行内代码，自动处理内容中的反引号。
   *
   * @param {string} content
   * @returns {string}
   * @private
   */
  _wrapInlineCode(content) {
    const normalized = String(content || '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return '';
    }

    const backtickRuns = normalized.match(/`+/g) || [];
    const longestBacktickRun = backtickRuns.reduce((max, run) => Math.max(max, run.length), 0);
    const fence = '`'.repeat(longestBacktickRun + 1);
    const needsPadding = normalized.startsWith('`') || normalized.endsWith('`');

    return needsPadding ? `${fence} ${normalized} ${fence}` : `${fence}${normalized}${fence}`;
  }

  /**
   * 将 HTML table 结构化转换为 Markdown 表格，避免丢失列关系。
   *
   * @param {Element} tableNode
   * @returns {string}
   * @private
   */
  _convertTableToMarkdown(tableNode) {
    const rowNodes = Array.from(tableNode.querySelectorAll('tr')).filter((row) =>
      Array.from(row.children).some((cell) => /^(TH|TD)$/.test(cell.nodeName))
    );

    if (rowNodes.length === 0) {
      return '';
    }

    const rows = rowNodes.map((row) =>
      Array.from(row.children)
        .filter((cell) => /^(TH|TD)$/.test(cell.nodeName))
        .map((cell) => this._serializeTableCell(cell))
    );

    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (columnCount === 0) {
      return '';
    }

    const normalizedRows = rows.map((row) =>
      Array.from({ length: columnCount }, (_, index) => row[index] ?? '')
    );

    const headerRow = normalizedRows[0];
    const bodyRows = normalizedRows.slice(1);
    const renderRow = (cells) =>
      `| ${cells.map((cell) => (cell && cell.trim() ? cell : ' ')).join(' | ')} |`;

    return [
      renderRow(headerRow),
      `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`,
      ...bodyRows.map(renderRow),
    ].join('\n');
  }

  /**
   * 将表格单元格序列化为 Markdown 友好的行内内容。
   *
   * @param {Element} cellNode
   * @returns {string}
   * @private
   */
  _serializeTableCell(cellNode) {
    const markdown = this._serializeInlineNode(cellNode)
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    return markdown.replace(/\|/g, '\\|');
  }

  /**
   * 递归提取节点中的行内 Markdown。
   *
   * @param {Node} node
   * @returns {string}
   * @private
   */
  _serializeInlineNode(node) {
    if (!node) {
      return '';
    }

    if (node.nodeType === 3) {
      return node.textContent || '';
    }

    if (node.nodeType !== 1) {
      return '';
    }

    const tagName = node.nodeName.toUpperCase();
    const childrenContent = Array.from(node.childNodes)
      .map((child) => this._serializeInlineNode(child))
      .join('');

    switch (tagName) {
      case 'BR':
        return '<br>';
      case 'CODE':
      case 'KBD':
        return this._wrapInlineCode(node.textContent || '');
      case 'STRONG':
      case 'B': {
        const content = childrenContent.trim();
        return content ? `**${content}**` : '';
      }
      case 'EM':
      case 'I': {
        const content = childrenContent.trim();
        return content ? `*${content}*` : '';
      }
      case 'A': {
        const content = childrenContent.trim() || (node.textContent || '').trim();
        const href = node.getAttribute('href');
        return href ? `[${content}](${href})` : content;
      }
      case 'IMG': {
        const alt = node.getAttribute('alt') || '';
        const src = node.getAttribute('src') || '';
        return src ? `![${alt}](${src})` : alt;
      }
      default:
        return childrenContent;
    }
  }

  /**
   * 规范化图像与图注：
   * - 如果某行是斜体（例如 _Figure 1: ..._ 或 *Figure 1: ...*），
   * - 且其前一行（忽略空行）是 Markdown 图片行，并且两者文本几乎相同，
   *   则视为重复图注，删除斜体行，仅保留图片行作为 caption。
   * 这样可以与 Pandoc 的 implicit_figures 行为对齐：
   *   一张图片（单独成段）= 一个 figure + 一个 caption（来自 alt 文本）。
   * @param {string} markdown
   * @returns {string}
   */
  _normalizeFigureCaptions(markdown) {
    if (!markdown || typeof markdown !== 'string') {
      return markdown;
    }

    const lines = markdown.split('\n');

    const normalizeText = (text) => {
      if (!text) return '';
      return (
        text
          .trim()
          // 去掉首尾的强调符号（_ 或 *）
          .replace(/^[*_]+/, '')
          .replace(/[*_]+$/, '')
          .trim()
          // 去掉结尾的句号/感叹号等常见标点
          .replace(/[。．.!！]+$/u, '')
          .trim()
          .toLowerCase()
      );
    };

    const result = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // 匹配整行斜体：_text_ 或 *text*
      const italicMatch = trimmed.match(/^([*_])(.+)\1$/);
      if (italicMatch) {
        const italicText = italicMatch[2].trim();

        // 向上寻找上一行非空行
        let prevIndex = i - 1;
        while (prevIndex >= 0 && lines[prevIndex].trim() === '') {
          prevIndex--;
        }

        if (prevIndex >= 0) {
          const prevTrimmed = lines[prevIndex].trim();
          // 匹配单独一行的图片语法，允许可选的属性块：
          // ![alt](src) 或 ![alt](src){ ... }
          const imageMatch = prevTrimmed.match(/^!\[([^\]]+)\]\([^)]*\)\s*(\{[^}]*\})?$/);
          if (imageMatch) {
            const altText = imageMatch[1].trim();
            const normAlt = normalizeText(altText);
            const normItalic = normalizeText(italicText);

            if (normAlt && normAlt === normItalic) {
              // 认为是重复图注：跳过当前斜体行，不输出
              continue;
            }
          }
        }
      }

      result.push(line);
    }

    return result.join('\n');
  }

  /**
   * 将“图片后直接粘正文”的行拆分为独立图片块和正文段落，避免 Pandoc
   * 把块级插图挤成同一行，影响阅读和 figure 渲染。
   *
   * @param {string} markdown
   * @returns {string}
   * @private
   */
  _normalizeStandaloneImageBlocks(markdown) {
    if (!markdown || typeof markdown !== 'string') {
      return markdown;
    }

    const lines = markdown.split('\n');
    const result = [];
    let inFence = false;
    let fenceChar = '';
    let fenceCount = 0;

    for (const line of lines) {
      const fenceMatch = line.match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        const currentFenceChar = fenceMatch[1][0];
        const currentFenceCount = fenceMatch[1].length;

        if (!inFence) {
          inFence = true;
          fenceChar = currentFenceChar;
          fenceCount = currentFenceCount;
        } else if (currentFenceChar === fenceChar && currentFenceCount >= fenceCount) {
          inFence = false;
        }

        result.push(line);
        continue;
      }

      if (inFence) {
        result.push(line);
        continue;
      }

      const markdownImageMatch = line.match(
        /^(!\[[^\]]*]\([^)]+\)(?:\s*\{[^}]*\})?)(?=\S)(.+)$/
      );
      if (markdownImageMatch) {
        result.push(markdownImageMatch[1], '', markdownImageMatch[2]);
        continue;
      }

      const htmlImageMatch = line.match(/^(<img\b[^>]*>)(?=\S)(.+)$/i);
      if (htmlImageMatch) {
        result.push(htmlImageMatch[1], '', htmlImageMatch[2]);
        continue;
      }

      result.push(line);
    }

    return result.join('\n');
  }

  /**
   * 将 HTML 字符串转换为 Markdown
   * @param {string} html
   * @returns {string}
   */
  convertHtmlToMarkdown(html, options = {}) {
    if (!html || typeof html !== 'string') {
      return '';
    }

    try {
      const rawMarkdown = this.turndown.turndown(html);
      const normalizedMarkdown = this.normalizeResourceUrls(rawMarkdown, options.pageUrl);
      const normalizedFigureBlocks = this._normalizeStandaloneImageBlocks(normalizedMarkdown);
      const dedupedMarkdown = this._normalizeFigureCaptions(normalizedFigureBlocks);
      const markdown = this.sanitizeMarkdown(dedupedMarkdown, options);
      this.logger?.debug?.('HTML 转 Markdown 完成', {
        length: markdown.length,
        ...options.debugMeta,
      });
      return markdown;
    } catch (error) {
      this.logger?.error?.('HTML 转 Markdown 失败', { error: error.message });
      throw error;
    }
  }

  /**
   * 从 Puppeteer 页面中提取内容区域，并转换为 Markdown
   * - 对 SVG 进行预处理：提取有意义的文本，忽略纯数字刻度
   * @param {import('puppeteer').Page} page
   * @param {string} selector
   * @returns {Promise<string>}
   */
  async extractAndConvertPage(page, selector) {
    const pageUrl = typeof page.url === 'function' ? page.url() : undefined;
    const siteAdapter = this._siteAdapterFor(pageUrl);

    // Work on a detached clone so neither the site step nor the SVG step touches the live page.
    const contentHandle = await page.evaluateHandle(
      (contentSelector) => document.querySelector(contentSelector)?.cloneNode(true) ?? null,
      selector
    );

    let siteData = {};
    let html;
    let svgCount;
    try {
      const transformContentClone = siteAdapter?.constructor.transformContentClone;
      if (transformContentClone) {
        siteData = await page.evaluate(transformContentClone, contentHandle, pageUrl);
      }
      ({ html, svgCount } = await page.evaluate(serializeContentClone, contentHandle));
    } finally {
      await contentHandle.dispose();
    }

    this.logger?.debug?.('从页面提取 HTML 完成', {
      hasContent: !!html,
      svgCount,
      siteAdapter: siteAdapter?.constructor.id,
    });

    let markdown = this.convertHtmlToMarkdown(html, {
      debugMeta: { svgCount },
      pageUrl,
    });

    markdown = siteAdapter?.normalizeExtractedMarkdown(markdown, { pageUrl, siteData }) ?? markdown;

    return markdown;
  }

  /**
   * 对 Markdown 做轻量级站点感知清洗，移除交互残留并保留正文可读性。
   *
   * @param {string} markdown
   * @param {Object} options
   * @returns {string}
   */
  sanitizeMarkdown(markdown, options = {}) {
    if (!markdown || typeof markdown !== 'string') {
      return '';
    }

    let sanitized = markdown;

    const siteAdapter = this._siteAdapterFor(options.pageUrl);
    if (siteAdapter) {
      sanitized = siteAdapter.postProcessMarkdown(sanitized, options.pageUrl);
    }

    sanitized = this._dedupeConsecutiveImageParagraphs(sanitized);

    return sanitized.replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * 删除相邻的重复图片段落，避免同一张截图因浅色/弹层结构被重复保留。
   *
   * @param {string} markdown
   * @returns {string}
   * @private
   */
  _dedupeConsecutiveImageParagraphs(markdown) {
    if (!markdown) return markdown;

    const paragraphs = markdown.split(/\n{2,}/);
    const result = [];

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();
      const previous = result[result.length - 1]?.trim();
      const isImageParagraph = /^(!\[[^\]]*]\([^)]*\)\s*)+$/.test(trimmed);

      if (isImageParagraph && previous === trimmed) {
        continue;
      }

      result.push(paragraph);
    }

    return result.join('\n\n');
  }

  /**
   * 为 Markdown 内容添加 YAML frontmatter
   * @param {string} markdown
   * @param {Object} metadata
   * @returns {string}
   */
  addFrontmatter(markdown, metadata = {}) {
    const includeFrontmatter = this.markdownConfig.includeFrontmatter !== false;

    if (!includeFrontmatter) {
      return markdown;
    }

    if (!metadata || Object.keys(metadata).length === 0) {
      return markdown;
    }

    // 如果已经存在 frontmatter，则不重复添加
    if (markdown.startsWith('---\n')) {
      return markdown;
    }

    const lines = ['---'];

    Object.entries(metadata).forEach(([key, value]) => {
      if (value === undefined || value === null) {
        return;
      }
      lines.push(`${key}: ${String(value)}`);
    });

    lines.push('---', '');

    const frontmatter = lines.join('\n');
    return `${frontmatter}${markdown}`;
  }

  /**
   * 解析 Markdown 中的 YAML frontmatter
   * 仅支持简单的 key: value 形式
   * @param {string} markdown
   * @returns {{ metadata: Object, content: string }}
   */
  parseFrontmatter(markdown) {
    if (!markdown || typeof markdown !== 'string') {
      return { metadata: {}, content: '' };
    }

    const lines = markdown.split('\n');
    if (lines.length === 0 || lines[0].trim() !== '---') {
      return { metadata: {}, content: markdown };
    }

    const metadata = {};
    let i = 1;

    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '---') {
        i++;
        break;
      }

      const match = line.match(/^([^:]+):\s*(.*)$/);
      if (!match) {
        continue;
      }

      const key = match[1].trim();
      const rawValue = match[2].trim();

      let value = rawValue;
      if (rawValue === 'true' || rawValue === 'false') {
        value = rawValue === 'true';
      } else if (!Number.isNaN(Number(rawValue)) && rawValue !== '') {
        value = Number(rawValue);
      }

      metadata[key] = value;
    }

    const content = lines.slice(i).join('\n').replace(/^\n+/, '');
    return { metadata, content };
  }
}
