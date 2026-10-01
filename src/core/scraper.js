/**
 * 核心爬虫：收集 URL、逐页抓取并生成 Markdown/PDF 产物
 */

import path from 'path';
import { EventEmitter } from 'events';
import { normalizeUrl, getUrlHash } from '../utils/url.js';
import { NetworkError, ScraperError, ValidationError } from '../utils/errors.js';
import { retry, delay } from '../utils/common.js';
import { HttpResourceService } from '../services/httpResourceService.js';

function httpError(status, url) {
  const error = new NetworkError(`HTTP ${status}: ${url}`, url);
  error.details.status = status;
  return error;
}

/** Client errors (4xx) and validation failures will fail the same way on every attempt. */
function isRetryableNavigationError(error) {
  if (error instanceof ValidationError) return false;
  const status = error?.details?.status;
  return !(status >= 400 && status < 500);
}

export class Scraper extends EventEmitter {
  constructor(dependencies) {
    super();

    // 依赖注入 - 集成所有服务
    this.config = dependencies.config;
    this.logger = dependencies.logger;
    this.browserPool = dependencies.browserPool;
    this.pageManager = dependencies.pageManager;
    this.fileService = dependencies.fileService;
    this.pathService = dependencies.pathService;
    this.metadataService = dependencies.metadataService;
    this.stateManager = dependencies.stateManager;
    this.progressTracker = dependencies.progressTracker;
    this.queueManager = dependencies.queueManager;
    this.imageService = dependencies.imageService;
    this.pdfStyleService = dependencies.pdfStyleService;
    this.translationService = dependencies.translationService;
    this.annotationService = dependencies.annotationService;
    this.markdownService = dependencies.markdownService;
    this.markdownToPdfService = dependencies.markdownToPdfService;
    this.httpResourceService = dependencies.httpResourceService || new HttpResourceService({ config: this.config, logger: this.logger });

    // 内部状态
    this.urlQueue = [];
    this.urlSet = new Set();
    this.isInitialized = false;
    this.isRunning = false;
    this.startTime = null;

    this.logger.info('Scraper constructor called', {
      hasTranslationService: !!this.translationService,
      hasAnnotationService: !!this.annotationService,
    });

    // 绑定事件处理
    this._bindEvents();
  }

  /**
   * 绑定事件处理器
   */
  _bindEvents() {
    // 监听状态管理器事件
    this.stateManager.on('stateLoaded', (state) => {
      this.logger.info('爬虫状态已加载', {
        processedCount: state.processedUrls.size,
        failedCount: state.failedUrls.size,
      });
    });

    // 监听进度追踪器事件
    this.progressTracker.on('progress', (stats) => {
      this.emit('progress', stats);
    });

    // 监听队列管理器事件
    this.queueManager.on('taskSuccess', ({ task }) => {
      this.logger.debug('任务完成', { url: task.url });
    });

    this.queueManager.on('taskFailed', ({ task, error }) => {
      this.logger.warn('任务失败', { url: task.url, error: error?.message });
    });
  }

  /**
   * 初始化爬虫
   */
  async initialize() {
    if (this.isInitialized) {
      this.logger.warn('爬虫已经初始化');
      return;
    }

    try {
      this.logger.info('开始初始化爬虫...');

      // stateManager 由容器加载，队列并发数由容器按 config.concurrency 创建
      // 确保输出目录存在
      await this.fileService.ensureDirectory(this.config.pdfDir);

      // 确保元数据目录存在
      const metadataDir = path.join(this.config.pdfDir, 'metadata');
      await this.fileService.ensureDirectory(metadataDir);

      this.isInitialized = true;
      this.logger.info('爬虫初始化完成');
      this.emit('initialized');
    } catch (error) {
      this.logger.error('爬虫初始化失败', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * 收集URL
   */
  async collectUrls() {
    if (!this.isInitialized) {
      throw new ValidationError('爬虫尚未初始化');
    }

    this.logger.debug('Checking targetUrls', { targetUrls: this.config.targetUrls });

    // 1. Structured explicit URLs mode: preserve curated document sections.
    if (Array.isArray(this.config.targetSections) && this.config.targetSections.length > 0) {
      const sections = this.config.targetSections.map((section, index) => ({
        index,
        title: section.title,
        entryUrl: section.entryUrl,
        urls: section.urls,
      }));
      const urlCount = sections.reduce((total, section) => total + section.urls.length, 0);

      this.logger.info('使用配置中的分组目标URL列表', {
        sectionCount: sections.length,
        urlCount,
      });

      return this._processCollectedUrls(sections);
    }

    // 2. Flat explicit URLs mode.
    if (
      this.config.targetUrls &&
      Array.isArray(this.config.targetUrls) &&
      this.config.targetUrls.length > 0
    ) {
      this.logger.info('使用配置中的目标URL列表', { count: this.config.targetUrls.length });

      const sectionInfo = {
        index: 0,
        title: 'Custom Selection',
        entryUrl: this.config.rootURL,
        urls: this.config.targetUrls,
      };

      return this._processCollectedUrls([sectionInfo]);
    }

    const entryPoints = this._getEntryPoints();
    this.logger.info('开始收集URL', { entryPoints });

    let page = null;
    try {
      // 创建页面
      page = await this.pageManager.createPage('url-collector');

      // 收集section信息（逐入口页面，保证使用各自侧边栏的顺序）
      const sections = [];
      const urlToSectionMap = new Map(); // URL -> section index
      const rawUrls = [];

      for (let sectionIndex = 0; sectionIndex < entryPoints.length; sectionIndex++) {
        const entryUrl = entryPoints[sectionIndex];

        try {
          const entryUrls = await this._collectUrlsFromEntryPoint(page, entryUrl, entryPoints);
          const sectionTitle = await this._extractSectionTitle(page, entryUrl);

          // 记录section信息
          const sectionInfo = {
            index: sectionIndex,
            title: sectionTitle,
            entryUrl: entryUrl,
            pages: [],
          };

          // 记录该section的所有URL及其顺序
          entryUrls.forEach((url, orderInSection) => {
            const startIndex = rawUrls.length;
            rawUrls.push(url);

            // 建立URL到section的映射
            urlToSectionMap.set(url, {
              sectionIndex,
              orderInSection,
              rawIndex: startIndex,
            });
          });

          sections.push(sectionInfo);

          this.logger.info(`Section ${sectionIndex + 1}/${entryPoints.length} 收集完成`, {
            title: sectionTitle,
            entryUrl,
            urlCount: entryUrls.length,
          });
        } catch (entryError) {
          this.logger.error('入口URL收集失败', {
            entryUrl,
            error: entryError.message,
          });

          throw entryError;
        }
      }
      this.logger.info(`提取到 ${rawUrls.length} 个原始URL，分属 ${sections.length} 个section`, {
        entryPointCount: entryPoints.length,
      });

      return this._processCollectedUrls(sections, urlToSectionMap, rawUrls);
    } catch (error) {
      this.logger.error('URL收集失败', {
        error: error.message,
        stack: error.stack,
      });
      throw new NetworkError('URL收集失败', this.config.rootURL, error);
    } finally {
      if (page) {
        // 在关闭页面前清理图片服务
        try {
          await this.imageService.cleanupPage(page);
        } catch (cleanupError) {
          this.logger?.debug('URL收集页面的图片服务清理失败（非致命错误）', {
            error: cleanupError.message,
          });
        }
        await this.pageManager.closePage('url-collector');
      }
    }
  }

  /**
   * 处理收集到的URL（去重、规范化、构建Section结构）
   */
  async _processCollectedUrls(sections, preCalculatedMap = null, preCalculatedRawUrls = null) {
    // 如果是直接传入 sections (targetUrls 模式)，需要构建 map 和 rawUrls
    let urlToSectionMap = preCalculatedMap;
    let rawUrls = preCalculatedRawUrls;

    if (!urlToSectionMap || !rawUrls) {
      urlToSectionMap = new Map();
      rawUrls = [];

      sections.forEach((section) => {
        if (section.urls) {
          section.urls.forEach((url, order) => {
            rawUrls.push(url);
            urlToSectionMap.set(url, {
              sectionIndex: section.index,
              orderInSection: order,
            });
          });
          // 清理临时 urls 字段
          delete section.urls;
          section.pages = [];
        }
      });
    }

    // URL去重和规范化
    const normalizedUrls = new Map();
    const duplicates = new Set();
    const sectionConflicts = []; // 记录section冲突

    rawUrls.forEach((url, index) => {
      try {
        const normalized = normalizeUrl(url);
        const hash = getUrlHash(normalized);

        if (normalizedUrls.has(hash)) {
          duplicates.add(url);

          // 检测section冲突
          const existing = normalizedUrls.get(hash);
          const currentMapping = urlToSectionMap.get(url);

          if (
            existing.sectionIndex !== currentMapping?.sectionIndex &&
            existing.sectionIndex !== undefined &&
            currentMapping?.sectionIndex !== undefined
          ) {
            sectionConflicts.push({
              url: normalized,
              existingSection: sections[existing.sectionIndex]?.title || existing.sectionIndex,
              conflictSection:
                sections[currentMapping.sectionIndex]?.title || currentMapping.sectionIndex,
            });
          }
          return;
        }

        if (!this.isIgnored(normalized) && this.validateUrl(normalized)) {
          // 保留section映射信息
          const sectionMapping = urlToSectionMap.get(url);

          normalizedUrls.set(hash, {
            original: url,
            normalized: normalized,
            index: index,
            sectionIndex: sectionMapping?.sectionIndex,
            orderInSection: sectionMapping?.orderInSection,
          });
        }
      } catch (error) {
        this.logger.warn('URL规范化失败', { url, error: error.message });
      }
    });

    // 报告section冲突
    if (sectionConflicts.length > 0) {
      this.logger.warn('检测到URL在多个section中重复', {
        conflictCount: sectionConflicts.length,
        examples: sectionConflicts.slice(0, 3),
      });

      if (sectionConflicts.length <= 5) {
        this.logger.debug('所有section冲突:', { conflicts: sectionConflicts });
      }
    }

    // 构建最终URL队列
    this.urlQueue = Array.from(normalizedUrls.values()).map((item) => item.normalized);
    this.urlQueue.forEach((url) => this.urlSet.add(url));

    // 构建section结构并填充pages信息
    const urlIndexMap = new Map(); // normalized URL -> final index
    Array.from(normalizedUrls.values()).forEach((item, finalIndex) => {
      urlIndexMap.set(item.normalized, finalIndex);

      // 将URL添加到对应的section
      if (item.sectionIndex !== undefined) {
        const section = sections[item.sectionIndex];
        if (section) {
          section.pages.push({
            index: String(finalIndex), // 转为字符串以匹配articleTitles的键格式
            url: item.normalized,
            order: item.orderInSection,
          });
        }
      }
    });

    // 按order排序每个section的pages
    sections.forEach((section) => {
      section.pages.sort((a, b) => a.order - b.order);
    });

    // 构建urlToSection快速查找映射
    const urlToSection = {};
    sections.forEach((section) => {
      section.pages.forEach((page) => {
        urlToSection[page.url] = section.index;
      });
    });

    // 保存section结构到元数据
    const sectionStructure = {
      sections,
      urlToSection,
    };

    // 保存到元数据服务
    await this.metadataService.saveSectionStructure(sectionStructure);

    // 详细的section统计信息
    this.logger.info('Section结构已保存', {
      sectionCount: sections.length,
      totalPages: Object.keys(urlToSection).length,
    });

    // 输出每个section的详细统计
    sections.forEach((section, idx) => {
      this.logger.debug(`Section ${idx + 1}/${sections.length}: "${section.title}"`, {
        entryUrl: section.entryUrl,
        pageCount: section.pages.length,
        firstPage: section.pages[0]?.url,
        lastPage: section.pages[section.pages.length - 1]?.url,
      });
    });

    // 检测空section
    const emptySections = sections.filter((s) => s.pages.length === 0);
    if (emptySections.length > 0) {
      this.logger.warn('检测到空section（没有页面）', {
        emptyCount: emptySections.length,
        titles: emptySections.map((s) => s.title),
      });
    }

    // 记录统计信息
    this.logger.info('URL收集完成', {
      原始数量: rawUrls.length,
      去重后数量: this.urlQueue.length,
      重复数量: duplicates.size,
      被忽略数量: rawUrls.length - this.urlQueue.length - duplicates.size,
      section数量: sections.length,
    });

    // 触发事件，便于外部监听URL收集结果
    this.emit('urlsCollected', {
      totalUrls: this.urlQueue.length,
      duplicates: duplicates.size,
      sections: sections.length,
    });

    return this.urlQueue;
  }

  /**
   * 根据配置构建入口URL列表
   * @returns {string[]} 入口URL数组
   */
  _getEntryPoints() {
    const entryPoints = [this.config.rootURL];

    if (Array.isArray(this.config.sectionEntryPoints)) {
      this.config.sectionEntryPoints.forEach((url) => {
        if (typeof url === 'string' && url.trim()) {
          entryPoints.push(url.trim());
        }
      });
    }

    // 检测并警告重复的entry points
    const originalLength = entryPoints.length;
    const deduplicated = Array.from(new Set(entryPoints));

    if (deduplicated.length < originalLength) {
      const duplicateCount = originalLength - deduplicated.length;
      this.logger.warn('检测到重复的entry points', {
        original: originalLength,
        deduplicated: deduplicated.length,
        duplicates: duplicateCount,
        hint: 'rootURL可能与sectionEntryPoints中的某个URL重复',
      });

      // 找出具体的重复项
      const seen = new Set();
      const duplicates = [];
      entryPoints.forEach((url) => {
        if (seen.has(url)) {
          duplicates.push(url);
        } else {
          seen.add(url);
        }
      });

      if (duplicates.length > 0) {
        this.logger.debug('重复的entry point URLs:', { duplicates });
      }
    }

    return deduplicated;
  }

  _normalizeUrlForEntryPointComparison(url) {
    try {
      const urlObj = new URL(url);
      urlObj.pathname = urlObj.pathname.replace(/\/$/, '');
      urlObj.search = '';
      urlObj.hash = '';
      return urlObj.toString();
    } catch {
      return url;
    }
  }

  /**
   * 从导航菜单中提取section标题
   * @param {import('puppeteer').Page} page
   * @param {string} entryUrl - Section entry URL
   * @returns {Promise<string|null>}
   */
  async _extractSectionTitle(page, entryUrl) {
    const configuredTitle = this.config.sectionTitles?.[entryUrl];
    if (configuredTitle) return configuredTitle;

    const title = await page.evaluate((targetUrl, selector) => {
      const target = new URL(targetUrl);
      for (const link of document.querySelectorAll(selector)) {
        const href = link.getAttribute('href');
        if (!href) continue;
        const url = new URL(href, window.location.href);
        if (url.origin === target.origin
          && url.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '')) {
          const text = link.textContent?.trim();
          if (text) return text;
        }
      }
      return document.querySelector('h1, [role="heading"][aria-level="1"]')?.textContent?.trim();
    }, entryUrl, this.config.navLinksSelector);

    if (!title) throw new ValidationError(`Missing section title: ${entryUrl}`);
    return title;
  }

  /**
   * 从单个入口页面收集URL
   * @param {import('puppeteer').Page} page
   * @param {string} entryUrl
   * @param {string[] | null} allEntryPoints
   * @returns {Promise<string[]>}
   */
  async _collectUrlsFromEntryPoint(page, entryUrl, allEntryPoints = null) {
    this.logger.info('处理入口页面', { entryUrl });

    const allUrls = [];
    let currentUrl = entryUrl;
    let pageNum = 1;
    const maxPages = this.config.maxPaginationPages || 10; // 默认最多翻10页，防止无限循环
    const otherEntryPoints = Array.isArray(allEntryPoints)
      ? allEntryPoints.filter((ep) => ep !== entryUrl)
      : [];
    const otherEntryPointSet = new Set(
      otherEntryPoints.map((url) => this._normalizeUrlForEntryPointComparison(url))
    );

    while (true) {
      this.logger.info(`开始导航到页面 [Page ${pageNum}]`, {
        currentUrl,
        waitUntil: 'domcontentloaded',
      });

      // 1. 导航到当前页面
      await retry(
        async () => {
          const gotoStartTime = Date.now();
          const waitUntil =
            this.config?.urlCollectionWaitUntil ||
            'domcontentloaded';
          const timeout = this.config?.pageTimeout || 30000;

          const response = await page.goto(currentUrl, {
            waitUntil,
            timeout,
          });

          const gotoEndTime = Date.now();
          this.logger.info('page.goto 完成', {
            url: currentUrl,
            duration: gotoEndTime - gotoStartTime,
            status: response?.status(),
          });
          if (response && response.status() >= 400) {
            throw httpError(response.status(), currentUrl);
          }

          // 尝试等待内容加载
          try {
            const selector = this.config.navLinksSelector || 'a[href]';
            await page.waitForSelector(selector, { timeout: 5000 });
          } catch {
            this.logger.debug('等待链接选择器超时，继续尝试提取');
          }

          return response;
        },
        {
          maxAttempts: this.config.maxRetries || 3,
          delay: 2000,
          shouldRetry: isRetryableNavigationError,
          onRetry: (attempt, error) => {
            this.logger.warn(`页面加载重试 ${attempt}次`, {
              url: currentUrl,
              error: error.message,
            });
          },
        }
      );

      // 2. 提取当前页面的链接（排除选择器在页面端防御性处理；跨-section入口过滤在Node端使用统一规范化）
      const excludeSelector = this.config.navExcludeSelector || '';

      const rawUrls = await page.evaluate(
        (selector, excludeSel) => {
          const isHttpUrl = (url) => {
            try {
              const u = new URL(url, window.location.href);
              return u.protocol === 'http:' || u.protocol === 'https:';
            } catch {
              return false;
            }
          };

          let elements = Array.from(document.querySelectorAll(selector));

          if (excludeSel) {
            let validExcludeSel = excludeSel;
            try {
              document.querySelector(validExcludeSel);
            } catch {
              validExcludeSel = '';
            }

            if (validExcludeSel) {
              elements = elements.filter((el) => !el.closest(validExcludeSel));
            }
          }

          return elements
            .map((el) => {
              const href = el?.href || el?.getAttribute?.('href');
              return typeof href === 'string' ? href.trim() : null;
            })
            .filter((href) => {
              if (!href) return false;
              if (href.startsWith('#')) return false;
              if (href.toLowerCase().startsWith('javascript:')) return false;
              return isHttpUrl(href);
            });
        },
        this.config.navLinksSelector,
        excludeSelector
      );

      const urls = rawUrls
        .map((href) => (typeof href === 'string' ? href.trim() : ''))
        .filter(
          (href) => href && !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:')
        )
        .map((href) => {
          try {
            const resolvedUrl = new URL(href, currentUrl);
            if (!['http:', 'https:'].includes(resolvedUrl.protocol)) {
              return null;
            }
            return resolvedUrl.toString();
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter((resolvedUrl) => {
          const normalized = this._normalizeUrlForEntryPointComparison(resolvedUrl);
          return !otherEntryPointSet.has(normalized);
        });

      this.logger.info(`Page ${pageNum} 提取到 ${urls.length} 个链接`);

      // 过滤掉非文章链接（可选，依赖选择器的准确性）
      // 这里我们假设 navLinksSelector 已经足够准确
      allUrls.push(...urls);

      // 3. 检查是否需要分页
      if (!this.config.paginationSelector) {
        break;
      }

      if (pageNum >= maxPages) {
        this.logger.info(`达到最大分页数 (${maxPages})，停止翻页`);
        break;
      }

      // 4. 寻找下一页链接
      const nextPageUrl = await page.evaluate((selector) => {
        // 支持多个选择器，用逗号分隔
        const selectors = selector.split(',').map((s) => s.trim());

        for (const s of selectors) {
          // 尝试找到"下一页"或"Older Posts"等链接
          // 这里我们查找匹配选择器的元素
          const links = Array.from(document.querySelectorAll(s));

          // 简单的启发式：通常是最后一个匹配的，或者包含特定文本
          // 对于Cloudflare blog，是 "Older Posts"
          // 我们假设选择器已经定位到了正确的 <a> 标签

          // 如果有多个匹配，通常分页链接在底部，取最后一个
          const link = links[links.length - 1];
          if (link) {
            return link.href;
          }
        }
        return null;
      }, this.config.paginationSelector);

      if (nextPageUrl && nextPageUrl !== currentUrl) {
        this.logger.info(`发现下一页: ${nextPageUrl}`);
        currentUrl = nextPageUrl;
        pageNum++;
      } else {
        this.logger.info('未发现下一页，分页结束');
        break;
      }
    }

    // 文档站点的入口页本身就是内容页；分页的博客列表页不是，因此只在非分页模式下收录入口页
    if (!this.config.paginationSelector) {
      // 检查是否已存在
      if (!allUrls.includes(entryUrl)) {
        allUrls.unshift(entryUrl);
      }
    }

    this.logger.debug('URL提取完成', {
      entryUrl,
      totalCount: allUrls.length,
      pagesScanned: pageNum,
    });

    return allUrls;
  }

  /**
   * 检查URL是否应被忽略
   */
  isIgnored(url) {
    if (!this.config.ignoreURLs || !Array.isArray(this.config.ignoreURLs)) {
      return false;
    }

    return this.config.ignoreURLs.some((pattern) => {
      if (typeof pattern === 'string') {
        return url.includes(pattern);
      }
      if (pattern instanceof RegExp) {
        return pattern.test(url);
      }
      return false;
    });
  }

  /**
   * 验证URL是否有效
   */
  validateUrl(url) {
    try {
      const parsedUrl = new URL(url);

      // 检查协议
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return false;
      }

      // 检查允许的域名
      if (this.config.allowedDomains && this.config.allowedDomains.length > 0) {
        const isAllowed = this.config.allowedDomains.some((domain) => {
          return parsedUrl.hostname === domain || parsedUrl.hostname.endsWith('.' + domain);
        });
        if (!isAllowed) {
          return false;
        }
      }

      // 检查baseUrl前缀过滤（去掉尾部斜杠以匹配normalizeUrl的行为）
      if (this.config.baseUrl) {
        const normalizedBase = this.config.baseUrl.replace(/\/+$/, '');
        if (!url.startsWith(normalizedBase)) {
          this.logger.debug('URL被baseUrl过滤', { url, baseUrl: normalizedBase });
          return false;
        }
      }

      return true;
    } catch (error) {
      this.logger.debug('URL验证失败', { url, error: error.message });
      return false;
    }
  }

  /**
   * 清理标题：移除常见的网站名称后缀
   * @param {string} title - 原始标题
   * @returns {string} 清理后的标题
   */
  _cleanTitle(title) {
    if (!title || typeof title !== 'string') {
      return '';
    }

    let cleaned = title.trim();

    // 移除常见的分隔符和网站名称后缀
    const separators = [
      ' | ', // "Overview | Claude Code" -> "Overview"
      ' - ', // "Overview - Claude Code" -> "Overview"
      ' – ', // en dash
      ' — ', // em dash
      ' :: ', // "Overview :: Docs" -> "Overview"
      ' • ', // bullet
      ' / ', // "Overview / Docs" -> "Overview"
    ];

    for (const sep of separators) {
      if (cleaned.includes(sep)) {
        const parts = cleaned.split(sep);
        // 保留第一部分（通常是页面标题）
        // 但要确保第一部分不为空且长度合理
        const firstPart = parts[0].trim();
        if (firstPart.length >= 2) {
          cleaned = firstPart;
          break;
        }
      }
    }

    // 如果清理后标题太短（可能是误删），返回原标题
    if (cleaned.length < 2 && title.length >= 2) {
      return title.trim();
    }

    return cleaned;
  }

  /**
   * 直接从 URL 获取 Markdown 源文件内容
   * 用于支持提供原始 .md 文件的文档站点（如 code.claude.com）
   * @param {string} url - 原始页面 URL
   * @returns {Promise<{content: string, title: string}>}
   */
  async _fetchMarkdownSource(url) {
    const sourceUrl = new URL(url);
    const suffix = this.config.markdownSource.urlSuffix || '.md';
    if (!sourceUrl.pathname.endsWith(suffix)) sourceUrl.pathname += suffix;
    sourceUrl.hash = '';
    const mdUrl = sourceUrl.href;
    const { buffer } = await this.httpResourceService.get(mdUrl, 'markdown');
    const content = buffer.toString('utf8');
    const title = content.match(/^#\s+(.+)$/m)?.[1].trim();
    if (!content.trim() || !title) {
      throw new ValidationError(`Markdown source must contain an H1 title: ${mdUrl}`);
    }
    this.logger.info('成功获取 Markdown 源文件', { mdUrl, contentLength: content.length, title });
    return { content, title };
  }

  async navigatePage(page, url) {
    const response = await page.goto(url, {
      waitUntil: this.config.navigationStrategy || 'domcontentloaded',
      timeout: this.config.pageTimeout || 30000,
    });
    if (response && response.status() >= 400) {
      throw httpError(response.status(), url);
    }
  }

  async _preparePageForScraping(page, url, index) {
    await this.imageService.setupImageObserver(page);

    await this.navigatePage(page, url);

    await this._waitForPageContent(page, url);
    const titleInfo = await this._extractPageTitle(page);
    const imagesLoaded = await this._preparePageContent(page, url, index);

    return { titleInfo, imagesLoaded };
  }

  async _waitForPageContent(page, url) {
    try {
      await page.waitForSelector(this.config.contentSelector, { timeout: 10000 });
    } catch (error) {
      this.logger.warn('内容选择器等待超时', {
        url,
        selector: this.config.contentSelector,
        error: error.message,
      });
      throw new ValidationError('页面内容未找到');
    }
  }

  async _extractPageTitle(page) {
    return page.evaluate((selector) => {
      const docTitle = document.title?.trim();
      if (docTitle) {
        return { title: docTitle, source: 'document.title' };
      }

      const contentElement = document.querySelector(selector);
      const contentCandidates = [
        ['h1', 'content-h1'],
        ['title, .title, .page-title, [class*="page-title"], [class*="PageTitle"]', 'content-title-class'],
        ['h2, h3', 'content-h2-h3'],
      ];

      for (const [candidateSelector, source] of contentCandidates) {
        const title = contentElement?.querySelector(candidateSelector)?.innerText?.trim();
        if (title) return { title, source };
      }

      const globalTitle = document.querySelector('h1')?.innerText?.trim();
      return globalTitle
        ? { title: globalTitle, source: 'global-h1' }
        : { title: '', source: 'none' };
    }, this.config.contentSelector);
  }

  async _preparePageContent(page, url, index) {
    const imagesLoaded = await this._loadPageImages(page, url, index);

    await this._runOptionalPageStep(
      () => this.pdfStyleService.processSpecialContent(page),
      '折叠元素展开失败',
      url
    );
    await this._runOptionalPageStep(
      () => this.pdfStyleService.removeDarkTheme(page),
      '深色主题移除失败',
      url
    );

    if (this.config.enablePDFStyleProcessing === true) {
      await this._runOptionalPageStep(
        () => this.pdfStyleService.applyPDFStyles(page, this.config.contentSelector),
        'PDF样式处理失败，跳过样式优化',
        url
      );
    }

    return imagesLoaded;
  }

  async _loadPageImages(page, url, index) {
    try {
      const imagesLoaded = await this.imageService.triggerLazyLoading(page);
      if (!imagesLoaded) {
        this.logger.warn(`部分图片未能加载: ${url}`);
        await this.metadataService.logImageLoadFailure(url, index);
      }
      return imagesLoaded;
    } catch (error) {
      this.logger.warn('图片加载处理失败', { url, error: error.message });
      await this.metadataService.logImageLoadFailure(url, index);
      return false;
    }
  }

  async _runOptionalPageStep(action, warningMessage, url) {
    try {
      await action();
    } catch (error) {
      this.logger.warn(warningMessage, { url, error: error.message });
    }
  }

  _isMarkdownWorkflowEnabled() {
    return Boolean(
      this.config.markdown?.enabled
      && this.config.markdownPdf?.enabled
    );
  }

  async _generatePageOutput({ page, url, index, title, pdfPath, markdown }) {
    if (!this._isMarkdownWorkflowEnabled()) {
      await this._translatePage(page, url);
      await this._generatePuppeteerPdf(page, pdfPath);
      return { actualOutputPath: pdfPath, isBatchMode: false };
    }

    return this._generateMarkdownOutput({ page, url, index, title, pdfPath, markdown });
  }

  async _generateMarkdownOutput({ page, url, index, title, pdfPath, markdown }) {
    const { markdownContent, sourceTitle } = markdown
      || await this._loadMarkdownContent(page, url, pdfPath);
    const markdownWithFrontmatter = this.markdownService.addFrontmatter(markdownContent, {
      title: sourceTitle || title,
      url,
      index,
    });
    const { outputMarkdown, variant } = await this._deriveMarkdownOutput(markdownWithFrontmatter);
    const markdownPath = await this._writeMarkdownArtifacts({
      pdfPath,
      markdownWithFrontmatter,
      outputMarkdown,
      variant,
    });

    if (this.config.markdownPdf?.batchMode) {
      this.logger.info('Batch mode enabled - skipping individual PDF generation', {
        url,
        markdownPath,
      });
      return { actualOutputPath: markdownPath, isBatchMode: true };
    }

    await this.markdownToPdfService.convertContentToPdf(
      outputMarkdown,
      pdfPath,
      { ...this.config.markdownPdf, sourceUrl: url }
    );
    this.logger.info('Markdown 工作流 PDF 已生成', { pdfPath });
    return { actualOutputPath: pdfPath, isBatchMode: false };
  }

  async _loadMarkdownContent(page, url, pdfPath) {
    if (this.config.markdownSource?.enabled) {
      const source = await this._fetchMarkdownSource(url);
        const normalizedSource = this.markdownService.normalizeResourceUrls(source.content, url);
        const markdownContent = this.markdownService.sanitizeMarkdown(normalizedSource, {
          pageUrl: url,
        });
        this.logger.info('使用直接获取的 Markdown 源文件', {
          url,
          pdfPath,
          titleFromSource: source.title,
        });
        return { markdownContent, sourceTitle: source.title };
    }

    this.logger.info('使用 DOM 转换 Markdown 工作流', { url, pdfPath });
    return {
      markdownContent: await this.markdownService.extractAndConvertPage(
        page,
        this.config.contentSelector
      ),
      sourceTitle: null,
    };
  }

  async _deriveMarkdownOutput(markdownWithFrontmatter) {
    if (this.config.translation?.enabled) {
      return {
        outputMarkdown: await this.translationService.translateMarkdown(markdownWithFrontmatter),
        variant: 'translated',
      };
    }
    if (this.config.annotations?.enabled) {
      if (!this.annotationService) throw new ValidationError('Annotation service is unavailable');
      return {
        outputMarkdown: await this.annotationService.annotateMarkdown(markdownWithFrontmatter),
        variant: 'annotated',
      };
    }
    return { outputMarkdown: markdownWithFrontmatter, variant: 'original' };
  }

  async _writeMarkdownArtifacts({ pdfPath, markdownWithFrontmatter, outputMarkdown, variant }) {
    const markdownOutputDir = path.join(
      this.config.pdfDir,
      this.config.markdown?.outputDir || 'markdown'
    );
    const baseName = path.basename(pdfPath, '.pdf');
    const originalMarkdownPath = path.join(markdownOutputDir, `${baseName}.md`);
    const translatedMarkdownPath = path.join(markdownOutputDir, `${baseName}_translated.md`);
    const annotatedMarkdownPath = path.join(markdownOutputDir, `${baseName}_annotated.md`);

    await this.fileService.writeText(originalMarkdownPath, markdownWithFrontmatter);
    if (variant === 'translated') {
      await this.fileService.writeText(translatedMarkdownPath, outputMarkdown);
      return translatedMarkdownPath;
    }
    if (variant === 'annotated') {
      await this.fileService.writeText(annotatedMarkdownPath, outputMarkdown);
      return annotatedMarkdownPath;
    }
    return originalMarkdownPath;
  }

  async _translatePage(page, url) {
    if (!this.config.translation?.enabled) return;
    this.logger.info('翻译页面', { url });
    await this.translationService.translatePage(page);
  }

  async _generatePuppeteerPdf(page, pdfPath) {
    this.logger.info('开始使用Puppeteer引擎生成PDF', { pdfPath });
    await page.pdf({
      ...this.pdfStyleService.getPDFOptions(),
      path: pdfPath,
    });
    this.logger.info(`PDF已保存: ${pdfPath}`);
  }

  async _persistScrapeSuccess({ url, index, titleInfo, output, imagesLoaded }) {
    const { title } = titleInfo;
    this.stateManager.setUrlIndex(url, index);
    await this._persistArticleTitle(url, index, titleInfo);
    await this.stateManager.recordArtifact(url, output.actualOutputPath);
    this.progressTracker.success(url);

    const processedCount = this.progressTracker.getStats().processed;
    if (processedCount % 10 === 0) {
      await this.stateManager.save();
      this.logger.debug('状态已保存', { processedCount });
    }

    const result = {
      status: 'success',
      title,
      outputPath: output.actualOutputPath,
      isBatchMode: output.isBatchMode,
      imagesLoaded,
    };
    this.emit('pageScraped', {
      url,
      index,
      title,
      outputPath: result.outputPath,
      isBatchMode: result.isBatchMode,
      imagesLoaded,
    });
    return result;
  }

  async _persistArticleTitle(url, index, titleInfo) {
    const cleanedTitle = this._cleanTitle(titleInfo.title);
    if (cleanedTitle) {
      await this.metadataService.saveArticleTitle(String(index), cleanedTitle);
      this.logger.info(`提取到标题 [${index}]: ${cleanedTitle}`, {
        source: titleInfo.source,
        original: titleInfo.title !== cleanedTitle ? titleInfo.title : undefined,
      });
      return;
    }

    throw new ValidationError(`Title extraction failed for ${url}: source=${titleInfo.source}`);
  }

  _recordScrapeFailure(url, index, error, isRetry) {
    this.logger.error(`页面爬取失败 [${index + 1}]: ${url}`, {
      error: error.message,
      stack: error.stack,
    });
    this.stateManager.markFailed(url, error);
    const willRetry = this.config.retryFailedUrls !== false && !isRetry;
    this.progressTracker.failure(url, error, willRetry);
    this.emit('pageScrapeFailed', { url, index, error: error.message });
  }

  async _cleanupScrapePage(page, pageId) {
    if (!page) return;

    try {
      await this.imageService.cleanupPage(page);
    } catch (error) {
      this.logger?.debug('图片服务页面清理失败（非致命错误）', {
        error: error.message,
      });
    }
    await this.pageManager.closePage(pageId);
  }

  /**
   * 爬取单个页面
   */
  async scrapePage(url, index, options = {}) {
    const { isRetry = false } = options;

    // 检查是否已处理
    if (await this.stateManager.canResume(url)) {
      this.logger.debug(`跳过已处理的URL: ${url}`);
      this.progressTracker.skip(url);
      return { status: 'skipped', reason: 'already_processed' };
    }

    const pageId = `scraper-page-${index}`;
    let page = null;

    try {
      this.logger.info(`开始爬取页面 [${index + 1}/${this.urlQueue.length}]: ${url}`);
      this.progressTracker.startUrl?.(url);

      // 生成PDF时使用数字索引而不是哈希
      const pdfPath = this.pathService.getPdfPath(url, {
        useHash: false, // 使用索引而不是哈希
        index: index,
      });

      await this.fileService.ensureDirectory(path.dirname(pdfPath));

      let titleInfo;
      let imagesLoaded = null;
      let markdown;
      if (this.config.markdownSource?.enabled) {
        markdown = await this._loadMarkdownContent(null, url, pdfPath);
        titleInfo = { title: markdown.sourceTitle, source: 'markdown' };
      } else {
        page = await this.pageManager.createPage(pageId);
        ({ titleInfo, imagesLoaded } = await this._preparePageForScraping(page, url, index));
      }

      const output = await this._generatePageOutput({
        page, url, index, title: titleInfo.title, pdfPath, markdown,
      });
      return await this._persistScrapeSuccess({
        url,
        index,
        titleInfo,
        output,
        imagesLoaded,
      });
    } catch (error) {
      this._recordScrapeFailure(url, index, error, isRetry);
      if (error instanceof ScraperError) throw error;
      throw new NetworkError(`页面爬取失败: ${url}`, url, error);
    } finally {
      await this._cleanupScrapePage(page, pageId);
    }
  }

  /**
   * 重试失败的URL
   */
  async retryFailedUrls() {
    const failedUrls = this.stateManager.getFailedUrls();
    if (failedUrls.length === 0) {
      this.logger.info('没有需要重试的失败URL');
      return;
    }

    this.logger.info(`开始重试 ${failedUrls.length} 个失败的URL`);

    let retrySuccessCount = 0;
    let retryFailCount = 0;
    let staleSkipCount = 0;

    for (const [url, errorInfo] of failedUrls) {
      try {
        this.logger.info(`重试失败的URL: ${url}`);

        // 兜底保护：如果URL已在已处理集合中，说明失败记录是脏数据
        if (this.stateManager.isProcessed(url)) {
          staleSkipCount++;
          this.logger.warn('检测到失败URL已是已处理状态，跳过重试并清理失败记录', { url });
          this.stateManager.clearFailure(url);
          continue;
        }

        // 清除失败状态
        this.stateManager.clearFailure(url);

        // 重新爬取
        const index = this.urlQueue.indexOf(url);
        const realIndex = index >= 0 ? index : this.urlQueue.length;

        await this.scrapePage(url, realIndex, { isRetry: true });
        retrySuccessCount++;

        // 重试间隔
        await delay(this.config.retryDelay || 2000);
      } catch (retryError) {
        retryFailCount++;
        this.logger.error(`重试失败: ${url}`, {
          原始错误: errorInfo?.message || 'Unknown',
          重试错误: retryError.message,
        });

        // 重新标记为失败
        this.stateManager.markFailed(url, retryError);
      }
    }

    this.logger.info('重试完成', {
      成功: retrySuccessCount,
      失败: retryFailCount,
      跳过: staleSkipCount,
    });

    this.emit('retryCompleted', {
      successCount: retrySuccessCount,
      failCount: retryFailCount,
    });
  }

  /**
   * 运行爬虫
   */
  async run() {
    if (this.isRunning) {
      throw new ValidationError('爬虫已在运行中');
    }

    this.isRunning = true;
    this.startTime = Date.now();

    try {
      this.logger.info('=== 开始运行爬虫 ===');

      // 初始化
      await this.initialize();

      // 收集URL
      const urls = await this.collectUrls();
      if (urls.length === 0) {
        throw new ValidationError('没有找到可爬取的URL');
      }

      const resumed = await this.stateManager.prepareRun(urls, this.config);
      if (!resumed) await this.metadataService.resetArticleTitles();
      if (this.config.state?.autoSave !== false) this.stateManager.startAutoSave();

      // 初始化运行时状态基线，避免统计依赖延迟更新导致计数不一致
      this.stateManager.setStartTime();

      // 开始进度追踪
      this.progressTracker.start(urls.length);

      // 添加任务到队列
      urls.forEach((url, index) => {
        this.queueManager.addTask(
          `scrape-${index}`,
          async () => {
            try {
              await this.scrapePage(url, index);
            } catch (error) {
              // 错误已经被记录，这里只是防止队列中断
              this.logger.debug('队列任务失败，但已处理', { url, error: error.message });
            }
          },
          {
            url: url,
            priority: 0,
          }
        ).catch((error) => {
          // 防御性兜底：p-queue v9 timeout rejection 已由 queueManager 内部处理
          this.logger.debug('队列任务异常（已由 queueManager 处理）', { url, error: error?.message });
        });
      });

      // 等待所有任务完成
      await this.queueManager.waitForIdle();

      // 保存最终状态
      await this.stateManager.save(true);

      // 重试失败的URL
      if (this.config.retryFailedUrls !== false) {
        await this.retryFailedUrls();
        await this.stateManager.save(true);
      }

      // 完成
      this.progressTracker.finish();

      const duration = Date.now() - this.startTime;
      const stats = this.progressTracker.getStats();
      const succeededCount = stats.succeeded ?? stats.completed ?? 0;

      this.logger.info('=== 爬虫运行完成 ===', {
        总URL数: urls.length,
        成功数: succeededCount,
        失败数: stats.failed,
        跳过数: stats.skipped,
        HTTP: { ...this.httpResourceService.metrics },
        耗时: `${Math.round(duration / 1000)}秒`,
        成功率: `${((succeededCount / urls.length) * 100).toFixed(1)}%`,
      });

      this.emit('completed', {
        totalUrls: urls.length,
        stats: stats,
        duration: duration,
      });
    } catch (error) {
      this.logger.error('爬虫运行失败', {
        error: error.message,
        stack: error.stack,
      });

      this.emit('error', error);
      throw error;
    } finally {
      this.isRunning = false;

      // 清理资源
      try {
        await this.cleanup();
      } catch (cleanupError) {
        this.logger.error('资源清理失败', {
          error: cleanupError.message,
        });
      }
    }
  }

  /**
   * 暂停爬虫
   */
  async pause() {
    if (!this.isRunning) {
      this.logger.warn('爬虫未在运行，无法暂停');
      return;
    }

    this.logger.info('暂停爬虫...');
    await this.queueManager.pause();
    this.emit('paused');
  }

  /**
   * 恢复爬虫
   */
  async resume() {
    if (!this.isRunning) {
      this.logger.warn('爬虫未在运行，无法恢复');
      return;
    }

    this.logger.info('恢复爬虫...');
    await this.queueManager.resume();
    this.emit('resumed');
  }

  /**
   * 停止爬虫
   */
  async stop() {
    if (!this.isRunning) {
      this.logger.warn('爬虫未在运行');
      return;
    }

    this.logger.info('停止爬虫...');
    this.isRunning = false;

    await this.queueManager.clear();
    await this.cleanup();

    this.emit('stopped');
  }

  /**
   * 清理资源
   */
  async cleanup() {
    this.logger.info('开始清理资源...');
    this.stateManager?.stopAutoSave();

    try {
      // 1. 暂停并清理队列管理器
      if (this.queueManager) {
        this.queueManager.pause();
        this.queueManager.clear();
      }

      // 2. 图片服务的全局清理将由容器自动调用 dispose()
      // 这里不需要手动调用，避免重复清理

      // 3. 清理页面管理器（这会关闭所有页面）
      if (this.pageManager) {
        await this.pageManager.closeAll();
      }

      // 4. 清理浏览器池
      if (this.browserPool) {
        await this.browserPool.close();
      }

      // 5. 保存最终状态
      if (this.stateManager) {
        await this.stateManager.save(true);
      }

      this.logger.info('资源清理完成');
      this.emit('cleanup');
    } catch (error) {
      this.logger.error('资源清理失败', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * 获取爬虫状态
   */
  getStatus() {
    const stats = this.progressTracker.getStats();
    const queueStats = this.queueManager.getStatus();

    return {
      isInitialized: this.isInitialized,
      isRunning: this.isRunning,
      startTime: this.startTime,
      totalUrls: this.urlQueue.length,
      progress: stats,
      queue: queueStats,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
    };
  }
}

export default Scraper;
