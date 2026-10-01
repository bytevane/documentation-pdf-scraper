import { describe, it, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';

import { Scraper } from '../../src/core/scraper.js';
import { NetworkError, ValidationError } from '../../src/utils/errors.js';
import { EventEmitter } from 'events';

describe('Scraper', () => {
  let scraper;
  let mockDependencies;
  let mockPage;

  beforeEach(() => {
    mockPage = {
      goto: vi.fn(),
      evaluate: vi.fn(),
      waitForSelector: vi.fn(),
      pdf: vi.fn(),
      close: vi.fn(),
    };

    mockDependencies = {
      config: {
        rootURL: 'https://example.com',
        navLinksSelector: 'a',
        contentSelector: '.content',
        allowedDomains: ['example.com'],
        sectionEntryPoints: [],
        concurrency: 3,
        pdfDir: './pdfs',
        maxRetries: 3,
        pageTimeout: 30000,
        pdf: { engine: 'puppeteer' },
      },
      logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      browserPool: {
        isInitialized: false,
        initialize: vi.fn(),
        close: vi.fn(),
      },
      pageManager: {
        createPage: vi.fn().mockResolvedValue(mockPage),
        closePage: vi.fn(),
        closeAll: vi.fn(),
      },
      fileService: {
        ensureDirectory: vi.fn(),
        writeText: vi.fn(),
      },
      pathService: {
        getPdfPath: vi.fn().mockReturnValue('./pdfs/001-page.pdf'),
      },
      metadataService: {
        saveArticleTitle: vi.fn(),
        resetArticleTitles: vi.fn(),
        logImageLoadFailure: vi.fn(),
        logFailedLink: vi.fn(),
        saveSectionStructure: vi.fn(),
      },
      stateManager: {
        on: vi.fn(),
        load: vi.fn(),
        startAutoSave: vi.fn(),
        stopAutoSave: vi.fn(),
        save: vi.fn(),
        isProcessed: vi.fn().mockReturnValue(false),
        recordArtifact: vi.fn(),
        canResume: vi.fn().mockResolvedValue(false),
        prepareRun: vi.fn().mockResolvedValue(true),
        markFailed: vi.fn(),
        clearFailure: vi.fn(),
        setStartTime: vi.fn(),
        setUrlIndex: vi.fn(),
        getFailedUrls: vi.fn().mockReturnValue([]),
        state: {
          processedUrls: new Set(),
          failedUrls: new Map(),
        },
      },
      progressTracker: {
        on: vi.fn(),
        start: vi.fn(),
        startUrl: vi.fn(),
        skip: vi.fn(),
        success: vi.fn(),
        failure: vi.fn(),
        finish: vi.fn(),
        getStats: vi.fn().mockReturnValue({
          processed: 0,
          failed: 0,
          skipped: 0,
          total: 0,
        }),
      },
      queueManager: {
        on: vi.fn(),
        setConcurrency: vi.fn(),
        addTask: vi.fn(),
        waitForIdle: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        clear: vi.fn(),
        getStatus: vi.fn().mockReturnValue({
          pending: 0,
          active: 0,
          completed: 0,
          failed: 0,
        }),
      },
      imageService: {
        setupImageObserver: vi.fn(),
        triggerLazyLoading: vi.fn().mockResolvedValue(true),
        cleanupPage: vi.fn(),
      },
      pdfStyleService: {
        applyPDFStyles: vi.fn(),
        processSpecialContent: vi.fn(),
        removeDarkTheme: vi.fn(),
        getPDFOptions: vi.fn().mockReturnValue({
          format: 'A4',
          printBackground: true,
        }),
      },
      markdownService: null,
      translationService: null,
      annotationService: null,
      markdownToPdfService: null,
    };

    scraper = new Scraper(mockDependencies);
    scraper.httpResourceService.resolveHost = async () => [{ address: "93.184.216.34" }];
    scraper.httpResourceService.network.cacheEnabled = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe('explicit Markdown workflow', () => {
    beforeEach(() => {
      mockPage.goto.mockResolvedValue({ status: () => 200 });
      mockPage.evaluate.mockResolvedValue({ title: 'DOM guide', source: 'document.title' });
      scraper.config.markdown = { enabled: true };
      scraper.config.markdownPdf = { enabled: true, batchMode: true };
      scraper.config.markdownSource = { enabled: true };
      scraper.config.targetUrls = ['https://example.com/guide'];
      scraper.config.translation = { enabled: false };
      scraper.config.annotations = { enabled: false };
      scraper.markdownService = {
        normalizeResourceUrls: vi.fn((content) => content),
        sanitizeMarkdown: vi.fn((content) => content),
        addFrontmatter: vi.fn((content) => content),
        extractAndConvertPage: vi.fn().mockResolvedValue('# DOM guide'),
      };
      scraper.markdownToPdfService = { convertContentToPdf: vi.fn() };
      scraper.translationService = {
        translateMarkdown: vi.fn().mockResolvedValue('# Translated guide'),
      };
      scraper.annotationService = {
        annotateMarkdown: vi.fn().mockResolvedValue('# Source guide\n\n> **英语批注 · 高中**'),
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response('# Source guide\n\nContent.', {
          headers: { 'content-type': 'text/markdown' },
        })
      ));
    });

    it('fetches explicit Markdown without launching Chromium or touching DOM', async () => {
      await scraper.initialize();
      await scraper.collectUrls();
      const result = await scraper.scrapePage('https://example.com/guide', 1);

      expect(mockDependencies.browserPool.initialize).not.toHaveBeenCalled();
      expect(mockDependencies.pageManager.createPage).not.toHaveBeenCalled();
      expect(mockDependencies.imageService.setupImageObserver).not.toHaveBeenCalled();
      expect(scraper.markdownService.extractAndConvertPage).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ title: 'Source guide', isBatchMode: true });
      expect(mockDependencies.metadataService.saveArticleTitle).toHaveBeenCalledWith('1', 'Source guide');
      expect(scraper.translationService.translateMarkdown).not.toHaveBeenCalled();
      expect(mockDependencies.fileService.writeText).toHaveBeenCalledTimes(1);
      expect(result.outputPath).toBe('pdfs/markdown/001-page.md');
    });

    it.each([
      [503, 'text/markdown', 'Unavailable'],
      [200, 'text/html', '<html>Challenge</html>'],
      [200, 'text/markdown', ''],
      [200, 'text/markdown', 'No heading'],
    ])('rejects unusable Markdown (%s, %s) without a browser fallback', async (status, type, content) => {
      fetch.mockResolvedValue(new Response(content, { status, headers: { 'content-type': type } }));

      await expect(scraper.scrapePage('https://example.com/guide', 1)).rejects.toThrow();
      expect(mockDependencies.pageManager.createPage).not.toHaveBeenCalled();
      expect(mockDependencies.stateManager.recordArtifact).not.toHaveBeenCalled();
      expect(mockDependencies.stateManager.markFailed).toHaveBeenCalled();
    });

    it('keeps both artifacts only when translation is enabled', async () => {
      scraper.config.translation.enabled = true;
      const result = await scraper.scrapePage('https://example.com/guide', 1);
      expect(scraper.translationService.translateMarkdown).toHaveBeenCalledTimes(1);
      expect(mockDependencies.fileService.writeText).toHaveBeenCalledTimes(2);
      expect(result.outputPath).toBe('pdfs/markdown/001-page_translated.md');
    });

    it('keeps the English source and selects the annotated artifact when enabled', async () => {
      scraper.config.annotations.enabled = true;
      const result = await scraper.scrapePage('https://example.com/guide', 1);

      expect(scraper.annotationService.annotateMarkdown).toHaveBeenCalledWith(
        '# Source guide\n\nContent.'
      );
      expect(scraper.translationService.translateMarkdown).not.toHaveBeenCalled();
      expect(mockDependencies.fileService.writeText).toHaveBeenCalledTimes(2);
      expect(mockDependencies.fileService.writeText).toHaveBeenNthCalledWith(
        2,
        'pdfs/markdown/001-page_annotated.md',
        '# Source guide\n\n> **英语批注 · 高中**'
      );
      expect(result.outputPath).toBe('pdfs/markdown/001-page_annotated.md');
    });

    it('fails on Pandoc errors without switching renderers', async () => {
      scraper.config.markdownPdf.batchMode = false;
      scraper.markdownToPdfService.convertContentToPdf.mockRejectedValue(new Error('Pandoc failed'));
      await expect(scraper.scrapePage('https://example.com/guide', 1)).rejects.toThrow();
      expect(mockPage.pdf).not.toHaveBeenCalled();
      expect(mockDependencies.stateManager.recordArtifact).not.toHaveBeenCalled();
    });

    it('uses DOM extraction only when native Markdown is disabled', async () => {
      scraper.config.markdownSource.enabled = false;
      mockPage.goto.mockResolvedValue({ status: () => 200 });
      mockPage.evaluate.mockResolvedValue({ title: 'DOM guide', source: 'document.title' });
      await scraper.scrapePage('https://example.com/guide', 1);
      expect(fetch).not.toHaveBeenCalled();
      expect(scraper.markdownService.extractAndConvertPage).toHaveBeenCalledWith(mockPage, '.content');
    });
  });

  describe('constructor', () => {
    it('should initialize with dependencies', () => {
      expect(scraper.config).toBe(mockDependencies.config);
      expect(scraper.logger).toBe(mockDependencies.logger);
      expect(scraper.isInitialized).toBe(false);
      expect(scraper.isRunning).toBe(false);
    });

    it('should bind event handlers', () => {
      expect(mockDependencies.stateManager.on).toHaveBeenCalledWith(
        'stateLoaded',
        expect.any(Function)
      );
      expect(mockDependencies.progressTracker.on).toHaveBeenCalledWith(
        'progress',
        expect.any(Function)
      );
      expect(mockDependencies.queueManager.on).toHaveBeenCalledWith(
        'taskSuccess',
        expect.any(Function)
      );
      expect(mockDependencies.queueManager.on).toHaveBeenCalledWith(
        'taskFailed',
        expect.any(Function)
      );
    });

    it('should read the URL and error from QueueManager event payloads', () => {
      const handlerFor = (event) =>
        mockDependencies.queueManager.on.mock.calls.find(([name]) => name === event)[1];
      const task = { id: 'scrape-0', url: 'https://example.com/page' };

      expect(() =>
        handlerFor('taskFailed')({ id: task.id, error: new Error('boom'), task })
      ).not.toThrow();
      expect(mockDependencies.logger.warn).toHaveBeenCalledWith('任务失败', {
        url: task.url,
        error: 'boom',
      });

      handlerFor('taskSuccess')({ id: task.id, result: undefined, task });
      expect(mockDependencies.logger.debug).toHaveBeenCalledWith('任务完成', { url: task.url });
    });
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      await scraper.initialize();

      expect(mockDependencies.browserPool.initialize).not.toHaveBeenCalled();
      expect(mockDependencies.stateManager.load).toHaveBeenCalled();
      expect(mockDependencies.queueManager.setConcurrency).toHaveBeenCalledWith(3);
      expect(mockDependencies.fileService.ensureDirectory).toHaveBeenCalledWith('./pdfs');
      expect(mockDependencies.fileService.ensureDirectory).toHaveBeenCalledWith('pdfs/metadata');
      expect(scraper.isInitialized).toBe(true);
    });

    it('should not reinitialize if already initialized', async () => {
      scraper.isInitialized = true;
      await scraper.initialize();

      expect(mockDependencies.browserPool.initialize).not.toHaveBeenCalled();
      expect(mockDependencies.logger.warn).toHaveBeenCalledWith('爬虫已经初始化');
    });

    it('should handle initialization errors', async () => {
      const error = new Error('Init failed');
      mockDependencies.stateManager.load.mockRejectedValue(error);

      await expect(scraper.initialize()).rejects.toThrow(error);
      expect(mockDependencies.logger.error).toHaveBeenCalledWith(
        '爬虫初始化失败',
        expect.any(Object)
      );
    });
  });

  describe('collectUrls', () => {
    beforeEach(async () => {
      scraper.isInitialized = true;
      mockPage.goto.mockResolvedValue();
      mockPage.waitForSelector.mockResolvedValue();
    });

    it('should collect URLs successfully', async () => {
      mockPage.evaluate.mockResolvedValueOnce([
        'https://example.com/page1',
        'https://example.com/page2',
        'https://example.com/page1', // duplicate
        '#anchor', // invalid
        'javascript:void(0)', // invalid
      ]).mockResolvedValueOnce('Documentation');

      const urls = await scraper.collectUrls();

      expect(urls).toHaveLength(3);
      expect(urls).toContain('https://example.com/');
      expect(urls).toContain('https://example.com/page1');
      expect(urls).toContain('https://example.com/page2');
      expect(mockDependencies.pageManager.createPage).toHaveBeenCalledWith('url-collector');
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', expect.any(Object));
    });

    it('should preserve configured groups for curated explicit URLs', async () => {
      mockDependencies.config.targetSections = [
        {
          title: 'Core workflow',
          entryUrl: 'https://example.com/core',
          urls: ['https://example.com/core', 'https://example.com/memory'],
        },
        {
          title: 'Safety',
          entryUrl: 'https://example.com/permissions',
          urls: ['https://example.com/permissions'],
        },
      ];

      const urls = await scraper.collectUrls();

      expect(urls).toEqual([
        'https://example.com/core',
        'https://example.com/memory',
        'https://example.com/permissions',
      ]);
      expect(mockDependencies.pageManager.createPage).not.toHaveBeenCalled();
      expect(mockDependencies.metadataService.saveSectionStructure).toHaveBeenCalledWith({
        sections: [
          {
            index: 0,
            title: 'Core workflow',
            entryUrl: 'https://example.com/core',
            pages: [
              { index: '0', url: 'https://example.com/core', order: 0 },
              { index: '1', url: 'https://example.com/memory', order: 1 },
            ],
          },
          {
            index: 1,
            title: 'Safety',
            entryUrl: 'https://example.com/permissions',
            pages: [{ index: '2', url: 'https://example.com/permissions', order: 0 }],
          },
        ],
        urlToSection: {
          'https://example.com/core': 0,
          'https://example.com/memory': 0,
          'https://example.com/permissions': 1,
        },
      });
    });

    it('should throw if not initialized', async () => {
      scraper.isInitialized = false;
      await expect(scraper.collectUrls()).rejects.toThrow(ValidationError);
    });

    it('should handle navigation errors', async () => {
      const navError = new Error('Navigation failed');
      mockPage.goto.mockRejectedValue(navError);

      await expect(scraper.collectUrls()).rejects.toThrow('URL收集失败');
      expect(mockDependencies.metadataService.saveSectionStructure).not.toHaveBeenCalled();
    }, 30000);

    it('should clean up resources on error', async () => {
      mockPage.evaluate.mockRejectedValue(new Error('Evaluation failed'));

      await expect(scraper.collectUrls()).rejects.toThrow('URL收集失败');
      expect(mockDependencies.imageService.cleanupPage).toHaveBeenCalledWith(mockPage);
      expect(mockDependencies.pageManager.closePage).toHaveBeenCalledWith('url-collector');
    });
  });

  describe('_collectUrlsFromEntryPoint', () => {
    beforeEach(() => {
      mockPage.goto.mockResolvedValue({ status: () => 200 });
      mockPage.waitForSelector.mockResolvedValue();
    });

    it('should use urlCollectionWaitUntil for entry page navigation', async () => {
      scraper.config.urlCollectionWaitUntil = 'load';
      mockPage.evaluate.mockResolvedValue([]);

      const urls = await scraper._collectUrlsFromEntryPoint(mockPage, 'https://example.com/section1', [
        'https://example.com/section1',
      ]);

      expect(urls).toEqual(['https://example.com/section1']);
      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com/section1',
        expect.objectContaining({
          waitUntil: 'load',
          timeout: 30000,
        })
      );
    });

    it('should filter other entry points (ignore hash/query) and non-http(s) URLs', async () => {
      scraper.config.navExcludeSelector = '.nav-tabs';

      const getEntryPointsSpy = vi.spyOn(scraper, '_getEntryPoints');

      mockPage.evaluate.mockResolvedValue([
        'https://example.com/page1',
        'https://example.com/section2',
        'https://example.com/section2#hash',
        'https://example.com/section2?utm=1',
        'mailto:test@example.com',
        'tel:+123',
        '#anchor',
        'javascript:void(0)',
      ]);

      const urls = await scraper._collectUrlsFromEntryPoint(
        mockPage,
        'https://example.com/section1',
        ['https://example.com/section1', 'https://example.com/section2']
      );

      expect(getEntryPointsSpy).not.toHaveBeenCalled();
      expect(urls).toEqual(['https://example.com/section1', 'https://example.com/page1']);
    });
  });

  describe('validateUrl', () => {
    it('should accept valid URLs', () => {
      expect(scraper.validateUrl('https://example.com/page')).toBe(true);
      expect(scraper.validateUrl('http://example.com/page')).toBe(true);
    });

    it('should reject invalid URLs', () => {
      expect(scraper.validateUrl('invalid-url')).toBe(false);
      expect(scraper.validateUrl('ftp://example.com')).toBe(false);
      expect(scraper.validateUrl('')).toBe(false);
    });

    it('should check allowed domains', () => {
      expect(scraper.validateUrl('https://other.com')).toBe(false);
      expect(scraper.validateUrl('https://example.com')).toBe(true);
      expect(scraper.validateUrl('https://sub.example.com')).toBe(true);
      expect(scraper.validateUrl('https://test.sub.example.com')).toBe(true);
    });

    it('should filter by baseUrl if configured', () => {
      scraper.config.baseUrl = 'https://example.com/docs';
      expect(scraper.validateUrl('https://example.com/docs/page')).toBe(true);
      expect(scraper.validateUrl('https://example.com/other/page')).toBe(false);
    });
  });

  describe('isIgnored', () => {
    it('should check ignored patterns', () => {
      scraper.config.ignoreURLs = ['/admin', /\.pdf$/];

      expect(scraper.isIgnored('https://example.com/admin/page')).toBe(true);
      expect(scraper.isIgnored('https://example.com/file.pdf')).toBe(true);
      expect(scraper.isIgnored('https://example.com/normal/page')).toBe(false);
    });

    it('should handle missing ignoreURLs config', () => {
      scraper.config.ignoreURLs = null;
      expect(scraper.isIgnored('any-url')).toBe(false);
    });
  });

  describe('scrapePage', () => {
    const testUrl = 'https://example.com/page1';
    const testIndex = 0;

    beforeEach(() => {
      mockPage.goto.mockResolvedValue({ status: () => 200, statusText: () => 'OK' });
      mockPage.waitForSelector.mockResolvedValue();
      mockPage.evaluate.mockResolvedValue({ title: 'Page Title', source: 'document.title' });
    });

    it('should scrape page successfully with Puppeteer', async () => {
      scraper.config.enablePDFStyleProcessing = true;
      const result = await scraper.scrapePage(testUrl, testIndex);

      expect(result).toEqual({
        status: 'success',
        title: 'Page Title',
        outputPath: './pdfs/001-page.pdf',
        isBatchMode: false,
        imagesLoaded: true,
      });

      expect(mockDependencies.pageManager.createPage).toHaveBeenCalledWith('scraper-page-0');
      expect(mockDependencies.imageService.setupImageObserver).toHaveBeenCalledWith(mockPage);
      expect(mockDependencies.pdfStyleService.applyPDFStyles).toHaveBeenCalledWith(
        mockPage,
        '.content'
      );
      expect(mockPage.pdf).toHaveBeenCalledWith(
        expect.objectContaining({
          path: './pdfs/001-page.pdf',
          format: 'A4',
          printBackground: true,
        })
      );
      expect(mockDependencies.stateManager.recordArtifact).toHaveBeenCalledWith(
        testUrl,
        './pdfs/001-page.pdf'
      );
      expect(mockDependencies.metadataService.saveArticleTitle).toHaveBeenCalledWith(
        '0',
        'Page Title'
      );
    });

    it('should skip already processed pages', async () => {
      mockDependencies.stateManager.canResume.mockResolvedValue(true);

      const result = await scraper.scrapePage(testUrl, testIndex);

      expect(result).toEqual({
        status: 'skipped',
        reason: 'already_processed',
      });
      expect(mockDependencies.progressTracker.skip).toHaveBeenCalledWith(testUrl);
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it('should handle page navigation errors', async () => {
      mockPage.goto.mockRejectedValue(new Error('Navigation timeout'));

      await expect(scraper.scrapePage(testUrl, testIndex)).rejects.toThrow(NetworkError);
      expect(mockDependencies.stateManager.markFailed).toHaveBeenCalledWith(
        testUrl,
        expect.any(Error)
      );
      expect(mockDependencies.progressTracker.failure).toHaveBeenCalledWith(
        testUrl,
        expect.any(Error),
        true
      );
    });

    it('should handle content not found', async () => {
      mockPage.waitForSelector.mockRejectedValue(new Error('Timeout'));

      await expect(scraper.scrapePage(testUrl, testIndex)).rejects.toThrow(ValidationError);
      expect(mockDependencies.logger.warn).toHaveBeenCalledWith(
        '内容选择器等待超时',
        expect.any(Object)
      );
    });

    it('should clean up resources on error', async () => {
      mockPage.pdf.mockRejectedValue(new Error('PDF generation failed'));

      await expect(scraper.scrapePage(testUrl, testIndex)).rejects.toThrow();
      expect(mockDependencies.imageService.cleanupPage).toHaveBeenCalledWith(mockPage);
      expect(mockDependencies.pageManager.closePage).toHaveBeenCalledWith('scraper-page-0');
    });

    it('should not mark URL success before title persistence succeeds', async () => {
      mockDependencies.metadataService.saveArticleTitle.mockRejectedValueOnce(new Error('write fail'));

      await expect(scraper.scrapePage('https://example.com/page1', 0)).rejects.toThrow(NetworkError);

      expect(mockDependencies.stateManager.recordArtifact).not.toHaveBeenCalled();
      expect(mockDependencies.progressTracker.success).not.toHaveBeenCalled();
      expect(mockDependencies.progressTracker.failure).toHaveBeenCalled();
    });

    it('should mark first-pass failure as pending-retry when retries are enabled', async () => {
      const err = new Error('boom');
      mockPage.goto.mockRejectedValue(err);
      scraper.config.retryFailedUrls = true;

      await expect(
        scraper.scrapePage('https://example.com/page1', 0, { isRetry: false })
      ).rejects.toThrow();

      expect(mockDependencies.progressTracker.failure).toHaveBeenCalledWith(
        'https://example.com/page1',
        expect.any(Error),
        true
      );
    });

    it('should save state periodically', async () => {
      mockDependencies.progressTracker.getStats.mockReturnValue({ processed: 10 });

      await scraper.scrapePage(testUrl, testIndex);

      expect(mockDependencies.stateManager.save).toHaveBeenCalled();
    });

    it('should normalize relative asset URLs when using markdown source workflow', async () => {
      scraper.config.markdown = { enabled: true };
      scraper.config.markdownPdf = { enabled: true, batchMode: true };
      scraper.config.markdownSource = { enabled: true };

      mockDependencies.markdownService = {
        normalizeResourceUrls: vi.fn((content) =>
          content.replace('/images/app.png', 'https://example.com/images/app.png')
        ),
        sanitizeMarkdown: vi.fn((content) => content),
        extractAndConvertPage: vi.fn(),
        addFrontmatter: vi.fn((content) => content),
      };
      mockDependencies.markdownToPdfService = {
        convertContentToPdf: vi.fn(),
      };
      mockDependencies.translationService = null;

      scraper.markdownService = mockDependencies.markdownService;
      scraper.markdownToPdfService = mockDependencies.markdownToPdfService;
      scraper.translationService = null;

      vi.spyOn(scraper, '_fetchMarkdownSource').mockResolvedValue({
        content: '![App](/images/app.png)',
        title: 'Page Title',
      });

      const result = await scraper.scrapePage(testUrl, testIndex);

      expect(result.status).toBe('success');
      expect(mockDependencies.markdownService.normalizeResourceUrls).toHaveBeenCalledWith(
        '![App](/images/app.png)',
        testUrl
      );
      expect(mockDependencies.markdownService.sanitizeMarkdown).toHaveBeenCalledWith(
        '![App](https://example.com/images/app.png)',
        {
          pageUrl: testUrl,
        }
      );
      expect(mockDependencies.fileService.writeText).toHaveBeenCalledWith(
        expect.stringContaining('.md'),
        '![App](https://example.com/images/app.png)'
      );
    });
  });

  describe('navigatePage', () => {
    it('uses exactly the configured navigation strategy', async () => {
      scraper.config.navigationStrategy = 'load';
      mockPage.goto.mockResolvedValue({ status: () => 200 });
      await scraper.navigatePage(mockPage, 'https://example.com');
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', {
        waitUntil: 'load', timeout: 30000,
      });
    });

    it('reports navigation failure without switching strategies', async () => {
      mockPage.goto.mockRejectedValue(new Error('Navigation timeout'));
      await expect(scraper.navigatePage(mockPage, 'https://example.com')).rejects.toThrow('Navigation timeout');
      expect(mockPage.goto).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryFailedUrls', () => {
    it('should retry failed URLs', async () => {
      const failedUrls = [
        ['https://example.com/failed1', { message: 'Error 1' }],
        ['https://example.com/failed2', { message: 'Error 2' }],
      ];
      mockDependencies.stateManager.getFailedUrls.mockReturnValue(failedUrls);
      scraper.urlQueue = ['https://example.com/failed1'];

      mockPage.goto.mockResolvedValue({ status: () => 200 });
      mockPage.evaluate.mockResolvedValue({ title: 'Title', source: 'document.title' });

      await scraper.retryFailedUrls();

      expect(mockDependencies.logger.info).toHaveBeenCalledWith('开始重试 2 个失败的URL');
      expect(mockDependencies.logger.info).toHaveBeenCalledWith(
        '重试完成',
        expect.objectContaining({
          成功: expect.any(Number),
          失败: expect.any(Number),
        })
      );
    });

    it('should handle no failed URLs', async () => {
      mockDependencies.stateManager.getFailedUrls.mockReturnValue([]);

      await scraper.retryFailedUrls();

      expect(mockDependencies.logger.info).toHaveBeenCalledWith('没有需要重试的失败URL');
    });

    it('should skip stale failed URL already marked as processed', async () => {
      const staleUrl = 'https://example.com/stale';
      mockDependencies.stateManager.getFailedUrls.mockReturnValue([[staleUrl, { message: 'old' }]]);
      mockDependencies.stateManager.isProcessed.mockImplementation((url) => url === staleUrl);
      const scrapeSpy = vi.spyOn(scraper, 'scrapePage').mockResolvedValue({ status: 'success' });

      await scraper.retryFailedUrls();

      expect(mockDependencies.stateManager.clearFailure).toHaveBeenCalledWith(staleUrl);
      expect(scrapeSpy).not.toHaveBeenCalled();
      expect(mockDependencies.logger.warn).toHaveBeenCalledWith(
        '检测到失败URL已是已处理状态，跳过重试并清理失败记录',
        { url: staleUrl }
      );
    });
  });

  describe('run', () => {
    beforeEach(() => {
      scraper.initialize = vi.fn();
      scraper.collectUrls = vi.fn().mockResolvedValue(['https://example.com/page1']);
      scraper.scrapePage = vi.fn();
      scraper.cleanup = vi.fn();
      mockDependencies.queueManager.addTask.mockImplementation((id, task) => task());
    });

    it('should run scraper successfully', async () => {
      await scraper.run();

      expect(scraper.initialize).toHaveBeenCalled();
      expect(scraper.collectUrls).toHaveBeenCalled();
      expect(mockDependencies.stateManager.setStartTime).toHaveBeenCalledTimes(1);
      expect(mockDependencies.stateManager.setUrlIndex).toHaveBeenCalledWith(
        'https://example.com/page1',
        0
      );
      expect(mockDependencies.progressTracker.start).toHaveBeenCalledWith(1);
      expect(mockDependencies.queueManager.addTask).toHaveBeenCalled();
      expect(mockDependencies.queueManager.waitForIdle).toHaveBeenCalled();
      expect(mockDependencies.stateManager.save).toHaveBeenCalled();
      expect(mockDependencies.progressTracker.finish).toHaveBeenCalled();
      expect(scraper.cleanup).toHaveBeenCalled();
    });

    it('fails the run when its final checkpoint cannot be saved', async () => {
      mockDependencies.stateManager.save.mockRejectedValue(new Error('disk full'));
      await expect(scraper.run()).rejects.toThrow('disk full');
      expect(mockDependencies.stateManager.save).toHaveBeenCalledWith(true);
      expect(mockDependencies.progressTracker.finish).not.toHaveBeenCalled();
      expect(scraper.cleanup).toHaveBeenCalled();
    });

    it('honors retryFailedUrls=false at the orchestration boundary', async () => {
      scraper.config.retryFailedUrls = false;
      const retry = vi.spyOn(scraper, 'retryFailedUrls');
      await scraper.run();
      expect(retry).not.toHaveBeenCalled();
      expect(mockDependencies.stateManager.save).toHaveBeenCalledWith(true);
    });

    it('should use succeeded count for completion success metrics', async () => {
      scraper.collectUrls.mockResolvedValue([
        'https://example.com/page1',
        'https://example.com/page2',
        'https://example.com/page3',
      ]);
      mockDependencies.progressTracker.getStats.mockReturnValue({
        processed: 3,
        succeeded: 2,
        failed: 1,
        skipped: 0,
        total: 3,
      });

      await scraper.run();

      expect(mockDependencies.logger.info).toHaveBeenCalledWith(
        '=== 爬虫运行完成 ===',
        expect.objectContaining({
          总URL数: 3,
          成功数: 2,
          失败数: 1,
          跳过数: 0,
          成功率: '66.7%',
        })
      );
    });

    it('should throw if already running', async () => {
      scraper.isRunning = true;
      await expect(scraper.run()).rejects.toThrow(ValidationError);
    });

    it('should handle no URLs found', async () => {
      scraper.collectUrls.mockResolvedValue([]);

      await expect(scraper.run()).rejects.toThrow('没有找到可爬取的URL');
      expect(mockDependencies.queueManager.addTask).not.toHaveBeenCalled();
    });

    it('should cleanup on error', async () => {
      scraper.collectUrls.mockRejectedValue(new Error('Collection failed'));

      await expect(scraper.run()).rejects.toThrow();
      expect(scraper.cleanup).toHaveBeenCalled();
      expect(scraper.isRunning).toBe(false);
    });
  });

  describe('pause/resume/stop', () => {
    it('should pause scraper', async () => {
      scraper.isRunning = true;
      await scraper.pause();
      expect(mockDependencies.queueManager.pause).toHaveBeenCalled();
    });

    it('should resume scraper', async () => {
      scraper.isRunning = true;
      await scraper.resume();
      expect(mockDependencies.queueManager.resume).toHaveBeenCalled();
    });

    it('should stop scraper', async () => {
      scraper.isRunning = true;
      scraper.cleanup = vi.fn();

      await scraper.stop();

      expect(mockDependencies.queueManager.clear).toHaveBeenCalled();
      expect(scraper.cleanup).toHaveBeenCalled();
      expect(scraper.isRunning).toBe(false);
    });

    it('should warn if not running', async () => {
      scraper.isRunning = false;

      await scraper.pause();
      expect(mockDependencies.logger.warn).toHaveBeenCalledWith('爬虫未在运行，无法暂停');

      await scraper.resume();
      expect(mockDependencies.logger.warn).toHaveBeenCalledWith('爬虫未在运行，无法恢复');

      await scraper.stop();
      expect(mockDependencies.logger.warn).toHaveBeenCalledWith('爬虫未在运行');
    });
  });

  describe('cleanup', () => {
    it('should cleanup all resources', async () => {
      await scraper.cleanup();

      expect(mockDependencies.queueManager.pause).toHaveBeenCalled();
      expect(mockDependencies.queueManager.clear).toHaveBeenCalled();
      expect(mockDependencies.pageManager.closeAll).toHaveBeenCalled();
      expect(mockDependencies.browserPool.close).toHaveBeenCalled();
      expect(mockDependencies.stateManager.save).toHaveBeenCalled();
    });

    it('should handle cleanup errors gracefully', async () => {
      mockDependencies.browserPool.close.mockRejectedValue(new Error('Close failed'));

      await expect(scraper.cleanup()).rejects.toThrow();
      expect(mockDependencies.logger.error).toHaveBeenCalledWith(
        '资源清理失败',
        expect.any(Object)
      );
    });
  });

  describe('getStatus', () => {
    it('should return current status', () => {
      scraper.isInitialized = true;
      scraper.isRunning = true;
      scraper.startTime = Date.now() - 1000;
      scraper.urlQueue = ['url1', 'url2'];

      const status = scraper.getStatus();

      expect(status).toMatchObject({
        isInitialized: true,
        isRunning: true,
        totalUrls: 2,
        progress: expect.any(Object),
        queue: expect.any(Object),
        uptime: expect.any(Number),
      });
      expect(status.uptime).toBeGreaterThan(0);
    });
  });

  describe('event emissions', () => {
    it('should emit initialized event', async () => {
      const listener = vi.fn();
      scraper.on('initialized', listener);

      await scraper.initialize();

      expect(listener).toHaveBeenCalled();
    });

    it('should emit urlsCollected event', async () => {
      scraper.isInitialized = true;
      mockPage.goto.mockResolvedValue({ status: () => 200 });
      mockPage.waitForSelector.mockResolvedValue();

      // Discover links after navigation, then read the loaded page's section title.
      mockPage.evaluate
        .mockResolvedValueOnce(['https://example.com/page1'])
        .mockResolvedValueOnce('Section Title');

      const listener = vi.fn();
      scraper.on('urlsCollected', listener);

      await scraper.collectUrls();

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          totalUrls: expect.any(Number),
          duplicates: expect.any(Number),
          sections: expect.any(Number),
        })
      );
    });

    it('should emit pageScraped event', async () => {
      mockPage.goto.mockResolvedValue({ status: () => 200 });
      mockPage.evaluate.mockResolvedValue({ title: 'Title', source: 'document.title' });

      const listener = vi.fn();
      scraper.on('pageScraped', listener);

      await scraper.scrapePage('https://example.com/page', 0);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com/page',
          index: 0,
          outputPath: './pdfs/001-page.pdf',
          isBatchMode: false,
          imagesLoaded: true,
        })
      );
    });
  });

  describe('_cleanTitle', () => {
    it('should remove site name with pipe separator', () => {
      expect(scraper._cleanTitle('Overview | Claude Code')).toBe('Overview');
      expect(scraper._cleanTitle('Getting Started | Docs')).toBe('Getting Started');
    });

    it('should remove site name with dash separator', () => {
      expect(scraper._cleanTitle('Overview - Claude Code')).toBe('Overview');
      expect(scraper._cleanTitle('API Reference - Docs')).toBe('API Reference');
    });

    it('should remove site name with en dash', () => {
      expect(scraper._cleanTitle('Overview – Claude Code')).toBe('Overview');
    });

    it('should remove site name with em dash', () => {
      expect(scraper._cleanTitle('Overview — Claude Code')).toBe('Overview');
    });

    it('should remove site name with double colon', () => {
      expect(scraper._cleanTitle('Overview :: Docs')).toBe('Overview');
    });

    it('should remove site name with bullet', () => {
      expect(scraper._cleanTitle('Overview • Docs')).toBe('Overview');
    });

    it('should remove site name with slash', () => {
      expect(scraper._cleanTitle('Overview / Docs')).toBe('Overview');
    });

    it('should handle titles without separators', () => {
      expect(scraper._cleanTitle('Simple Title')).toBe('Simple Title');
      expect(scraper._cleanTitle('No Separator Here')).toBe('No Separator Here');
    });

    it('should handle empty or invalid titles', () => {
      expect(scraper._cleanTitle('')).toBe('');
      expect(scraper._cleanTitle(null)).toBe('');
      expect(scraper._cleanTitle(undefined)).toBe('');
    });

    it('should preserve original if cleaned title is too short', () => {
      expect(scraper._cleanTitle('A | Very Long Site Name')).toBe('A | Very Long Site Name');
    });

    it('should handle multiple separators (use first)', () => {
      expect(scraper._cleanTitle('Title | Site | More')).toBe('Title');
    });

    it('should trim whitespace', () => {
      expect(scraper._cleanTitle('  Title | Site  ')).toBe('Title');
      expect(scraper._cleanTitle('Title  ')).toBe('Title');
    });
  });

  describe('title extraction with multiple sources', () => {
    beforeEach(() => {
      mockPage.goto.mockResolvedValue({ status: () => 200 });
      mockPage.waitForSelector.mockResolvedValue();
      mockPage.pdf.mockResolvedValue();
    });

    it('should extract title from document.title', async () => {
      mockPage.evaluate.mockResolvedValue({
        title: 'Overview | Claude Code',
        source: 'document.title',
      });

      await scraper.scrapePage('https://example.com/page', 0);

      expect(mockDependencies.metadataService.saveArticleTitle).toHaveBeenCalledWith(
        '0',
        'Overview'
      );
    });

    it('should extract title from content h1 when document.title is empty', async () => {
      mockPage.evaluate.mockResolvedValue({
        title: 'Page Heading',
        source: 'content-h1',
      });

      await scraper.scrapePage('https://example.com/page', 0);

      expect(mockDependencies.metadataService.saveArticleTitle).toHaveBeenCalledWith(
        '0',
        'Page Heading'
      );
    });

    it('rejects missing titles instead of using a filename in the TOC', async () => {
      mockPage.evaluate.mockResolvedValue({
        title: '',
        source: 'none',
      });

      await expect(scraper.scrapePage('https://example.com/page', 0)).rejects.toThrow();
      expect(mockDependencies.metadataService.saveArticleTitle).not.toHaveBeenCalled();
    });
  });
});
