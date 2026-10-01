/**
 * 核心爬虫：收集 URL、逐页抓取并生成 Markdown/PDF 产物
 */

import path from 'path';
import { EventEmitter } from 'events';
import { NetworkError, ScraperError, ValidationError, httpError } from '../utils/errors.js';
import { delay } from '../utils/common.js';
import { HttpResourceService } from '../services/httpResourceService.js';
import { UrlCollector } from './urlCollector.js';

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
    this.urlCollector = new UrlCollector({
      config: this.config,
      logger: this.logger,
      pageManager: this.pageManager,
      imageService: this.imageService,
      metadataService: this.metadataService,
    });

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
   * 收集URL（由 UrlCollector 完成），并作为本次运行的队列
   */
  async collectUrls() {
    if (!this.isInitialized) {
      throw new ValidationError('爬虫尚未初始化');
    }

    const { urls, duplicates, sections } = await this.urlCollector.collect();
    this.urlQueue = urls;
    urls.forEach((url) => this.urlSet.add(url));

    // 触发事件，便于外部监听URL收集结果
    this.emit('urlsCollected', { totalUrls: urls.length, duplicates, sections });
    return this.urlQueue;
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
