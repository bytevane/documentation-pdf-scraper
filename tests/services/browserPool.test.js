import { describe, it, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';

import { BrowserError } from '../../src/utils/errors.js';

// Mock puppeteer-extra and stealth plugin before importing BrowserPool
vi.mock('puppeteer-extra');
vi.mock('puppeteer-extra-plugin-stealth');

// Import BrowserPool and mocked modules
import { BrowserPool } from '../../src/services/browserPool.js';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

describe('BrowserPool', () => {
  let browserPool;
  let mockLogger;
  let browserCount = 0;

  const createMockBrowser = (pid = 12345) => {
    return {
      on: vi.fn(),
      close: vi.fn(),
      connected: true,
      process: vi.fn().mockReturnValue({ pid: pid + browserCount++ }),
    };
  };

  beforeEach(() => {
    browserCount = 0;
    vi.clearAllMocks();

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    // Configure mocks
    puppeteer.launch.mockImplementation(() => Promise.resolve(createMockBrowser()));
    puppeteer.use.mockReturnValue(undefined);
    StealthPlugin.mockReturnValue({
      name: 'stealth',
      _isPuppeteerExtraPlugin: true,
    });

    browserPool = new BrowserPool({
      logger: mockLogger,
      maxBrowsers: 2,
      headless: true,
    });
  });

  describe('constructor', () => {
    it('closes browsers whose lazy launch finishes during shutdown', async () => {
      let finishLaunch;
      const browser = createMockBrowser();
      browserPool.options.maxBrowsers = 1;
      puppeteer.launch.mockReturnValue(new Promise((resolve) => { finishLaunch = resolve; }));
      const request = browserPool.getBrowser();
      const rejected = expect(request).rejects.toThrow('浏览器池已关闭');
      const closing = browserPool.close();
      finishLaunch(browser);
      await Promise.all([closing, rejected]);
      expect(browser.close).toHaveBeenCalledOnce();
      expect(browserPool.browsers).toEqual([]);
      await expect(browserPool.initialize()).rejects.toThrow('浏览器池已关闭');
    });
    it('initializes the pool once when concurrent callers first request browsers', async () => {
      const browsers = await Promise.all([browserPool.getBrowser(), browserPool.getBrowser()]);
      expect(puppeteer.launch).toHaveBeenCalledTimes(2);
      expect(new Set(browsers).size).toBe(2);
      expect(browserPool.isInitialized).toBe(true);
      browsers.forEach((browser) => browserPool.releaseBrowser(browser));
      await browserPool.close();
    });
    it('should initialize with default options', () => {
      const pool = new BrowserPool();

      expect(pool.options.maxBrowsers).toBe(1);
      expect(pool.options.headless).toBe(true);
      expect(pool.options.retryLimit).toBe(3);
      expect(pool.options.retryDelay).toBe(5000);
      expect(pool.browsers).toEqual([]);
      expect(pool.isInitialized).toBe(false);
      expect(pool.isClosed).toBe(false);
    });

    it('should accept custom options', () => {
      expect(browserPool.options.maxBrowsers).toBe(2);
      expect(browserPool.logger).toBe(mockLogger);
    });

    it('should initialize stats', () => {
      expect(browserPool.stats).toEqual({
        created: 0,
        disconnected: 0,
        errors: 0,
        totalRequests: 0,
        activeRequests: 0,
      });
    });
  });

  describe('initialize', () => {
    it('should initialize browser pool successfully', async () => {
      await browserPool.initialize();

      expect(puppeteer.launch).toHaveBeenCalledTimes(2);
      expect(browserPool.browsers).toHaveLength(2);
      expect(browserPool.availableBrowsers).toHaveLength(2);
      expect(browserPool.isInitialized).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith('浏览器池初始化完成', expect.any(Object));
    });

    it('should not reinitialize if already initialized', async () => {
      browserPool.isInitialized = true;

      await browserPool.initialize();

      expect(puppeteer.launch).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith('浏览器池已经初始化');
    });

    it('should handle partial browser creation failures', async () => {
      puppeteer.launch
        .mockResolvedValueOnce(createMockBrowser())
        .mockRejectedValueOnce(new Error('Browser creation failed'));

      await browserPool.initialize();

      expect(browserPool.browsers).toHaveLength(1);
      expect(browserPool.isInitialized).toBe(true);
      expect(mockLogger.error).toHaveBeenCalledWith(
        '创建第 2 个浏览器实例失败',
        expect.any(Object)
      );
    });

    it('should throw if no browsers can be created', async () => {
      puppeteer.launch.mockRejectedValue(new Error('Browser creation failed'));

      await expect(browserPool.initialize()).rejects.toThrow(BrowserError);
      expect(browserPool.isInitialized).toBe(false);
    });

    it('should emit initialized event', async () => {
      const listener = vi.fn();
      browserPool.on('initialized', listener);

      await browserPool.initialize();

      expect(listener).toHaveBeenCalledWith({ totalBrowsers: 2 });
    });
  });

  describe('createBrowser', () => {
    it('should create browser successfully', async () => {
      const browser = await browserPool.createBrowser();

      expect(browser).toHaveProperty('close');
      expect(browser.connected).toBe(true);
      expect(browser).toHaveProperty('on');
      expect(browser).toHaveProperty('process');
      expect(puppeteer.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          headless: true,
          defaultViewport: { width: 1920, height: 1080 },
          args: expect.arrayContaining(['--no-sandbox', '--disable-gpu']),
        })
      );
      expect(browserPool.stats.created).toBe(1);
    });

    it('keeps the same-origin policy on unless disableWebSecurity is set', async () => {
      await browserPool.createBrowser();
      expect(puppeteer.launch.mock.calls.at(-1)[0].args).not.toContain('--disable-web-security');

      const insecurePool = new BrowserPool({ disableWebSecurity: true, logger: mockLogger });
      await insecurePool.createBrowser();
      expect(puppeteer.launch.mock.calls.at(-1)[0].args).toContain('--disable-web-security');
    });

    it('should setup browser event listeners', async () => {
      const browser = await browserPool.createBrowser();

      expect(browser.on).toHaveBeenCalledWith('disconnected', expect.any(Function));
      expect(browser.on).toHaveBeenCalledWith('targetcreated', expect.any(Function));
      expect(browser.on).toHaveBeenCalledWith('targetdestroyed', expect.any(Function));
    });

    it('should emit browser-created event', async () => {
      const listener = vi.fn();
      browserPool.on('browser-created', listener);

      const browser = await browserPool.createBrowser();

      expect(listener).toHaveBeenCalledWith({ browser });
    });

    it('should handle creation errors', async () => {
      const launchError = new Error('Launch failed');
      puppeteer.launch.mockRejectedValue(launchError);

      const error = await browserPool.createBrowser().catch((caught) => caught);
      expect(error).toBeInstanceOf(BrowserError);
      expect(error.cause).toBe(launchError);
      expect(browserPool.stats.errors).toBe(1);
    });
  });

  describe('getBrowser', () => {
    beforeEach(async () => {
      await browserPool.initialize();
    });

    it('should get available browser', async () => {
      const browser = await browserPool.getBrowser();

      expect(browser).toHaveProperty('close');
      expect(browser.connected).toBe(true);
      expect(browserPool.availableBrowsers).toHaveLength(1);
      expect(browserPool.busyBrowsers).toHaveLength(1);
      expect(browserPool.stats.totalRequests).toBe(1);
      expect(browserPool.stats.activeRequests).toBe(1);
    });

    it('should lazily initialize if needed', async () => {
      const pool = new BrowserPool();

      const browser = await pool.getBrowser();
      expect(pool.isInitialized).toBe(true);
      pool.releaseBrowser(browser);
      await pool.close();
    });

    it('should throw if closed', async () => {
      browserPool.isClosed = true;

      await expect(browserPool.getBrowser()).rejects.toThrow('浏览器池已关闭');
    });

    it('should emit browser-acquired event', async () => {
      const listener = vi.fn();
      browserPool.on('browser-acquired', listener);

      await browserPool.getBrowser();

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          stats: expect.objectContaining({
            totalRequests: 1,
            activeRequests: 1,
          }),
        })
      );
    });
  });

  describe('waitForAvailableBrowser', () => {
    beforeEach(async () => {
      await browserPool.initialize();
    });

    it('should acquire a connected browser while waiting', async () => {
      const browser = browserPool.availableBrowsers[0];

      await expect(browserPool.waitForAvailableBrowser()).resolves.toBe(browser);

      expect(browserPool.busyBrowsers).toContain(browser);
      expect(browserPool.availableBrowsers).not.toContain(browser);
    });

    it('should skip a disconnected browser while waiting', async () => {
      vi.useFakeTimers();
      try {
        const [disconnectedBrowser, connectedBrowser] = browserPool.availableBrowsers;
        disconnectedBrowser.connected = false;

        const result = expect(browserPool.waitForAvailableBrowser()).resolves.toBe(
          connectedBrowser
        );
        await Promise.all([result, vi.advanceTimersByTimeAsync(500)]);

        expect(browserPool.disconnectedBrowsers).toContain(disconnectedBrowser);
        expect(browserPool.busyBrowsers).not.toContain(disconnectedBrowser);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });
  });

  describe('releaseBrowser', () => {
    beforeEach(async () => {
      await browserPool.initialize();
    });

    it('should release browser successfully', async () => {
      const browser = await browserPool.getBrowser();

      await browserPool.releaseBrowser(browser);

      expect(browserPool.availableBrowsers).toHaveLength(2);
      expect(browserPool.busyBrowsers).toHaveLength(0);
      expect(browserPool.stats.activeRequests).toBe(0);
    });

    it('should handle disconnected browsers', async () => {
      const browser = await browserPool.getBrowser();
      browser.connected = false;

      await browserPool.releaseBrowser(browser);

      expect(browserPool.disconnectedBrowsers).toHaveLength(1);
      expect(browserPool.availableBrowsers).not.toContain(browser);
    });

    it('should emit browser-released event', async () => {
      const listener = vi.fn();
      browserPool.on('browser-released', listener);

      const browser = await browserPool.getBrowser();
      await browserPool.releaseBrowser(browser);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          stats: expect.objectContaining({
            activeRequests: 0,
          }),
        })
      );
    });
  });

  describe('cleanup', () => {
    it('should replace only disconnected browsers', async () => {
      await browserPool.initialize();
      const [disconnectedBrowser, connectedBrowser] = browserPool.browsers;
      disconnectedBrowser.connected = false;
      const disconnectHandler = vi.spyOn(browserPool, 'handleBrowserDisconnect');

      await browserPool.cleanup();

      expect(disconnectHandler).toHaveBeenCalledExactlyOnceWith(disconnectedBrowser);
      expect(browserPool.browsers).not.toContain(disconnectedBrowser);
      expect(browserPool.browsers).toContain(connectedBrowser);
    });
  });

  describe('close', () => {
    beforeEach(async () => {
      await browserPool.initialize();
    });

    it('should close all browsers', async () => {
      await browserPool.close();

      expect(browserPool.isClosed).toBe(true);
      expect(browserPool.browsers.every((browser) => browser.close)).toBe(true);
    });

    it('should not close twice', async () => {
      await browserPool.close();
      await browserPool.close();

      expect(mockLogger.warn).toHaveBeenCalledWith('浏览器池已经关闭');
    });

    it('should emit closed event', async () => {
      const listener = vi.fn();
      browserPool.on('closed', listener);

      await browserPool.close();

      expect(listener).toHaveBeenCalled();
    });
  });
});
