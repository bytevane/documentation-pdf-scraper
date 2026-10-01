import { normalizeUrl, getUrlHash } from '../utils/url.js';
import { NetworkError, ValidationError, httpError } from '../utils/errors.js';
import { retry } from '../utils/common.js';

/** Client errors (4xx) and validation failures will fail the same way on every attempt. */
function isRetryableNavigationError(error) {
  if (error instanceof ValidationError) return false;
  const status = error?.details?.status;
  return !(status >= 400 && status < 500);
}

/**
 * URL 收集：入口页/分页导航、链接过滤与去重，并把 section 结构写入元数据。
 */
export class UrlCollector {
  constructor({ config, logger, pageManager, imageService, metadataService }) {
    this.config = config;
    this.logger = logger;
    this.pageManager = pageManager;
    this.imageService = imageService;
    this.metadataService = metadataService;
  }

  /**
   * 收集URL并保存 section 结构
   * @returns {Promise<{urls: string[], duplicates: number, sections: number}>}
   */
  async collect() {
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
    const urls = Array.from(normalizedUrls.values()).map((item) => item.normalized);

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
      去重后数量: urls.length,
      重复数量: duplicates.size,
      被忽略数量: rawUrls.length - urls.length - duplicates.size,
      section数量: sections.length,
    });

    return { urls, duplicates: duplicates.size, sections: sections.length };
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
}
