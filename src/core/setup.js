import Container from './container.js';
import { ProcessRunner } from '../utils/processRunner.js';
import { createLogger } from '../utils/logger.js';
import { ConfigLoader } from '../config/configLoader.js';
import { FileService } from '../services/fileService.js';
import { PathService } from '../services/pathService.js';
import { MetadataService } from '../services/metadataService.js';
import { StateManager } from '../services/stateManager.js';
import { ProgressTracker } from '../services/progressTracker.js';
import { QueueManager } from '../services/queueManager.js';
import { BrowserPool } from '../services/browserPool.js';
import { PageManager } from '../services/pageManager.js';
import { ImageService } from '../services/imageService.js';
import { PDFStyleService } from '../services/pdfStyleService.js';
import { TranslationService } from '../services/translationService.js';
import { AnnotationService } from '../services/annotationService.js';
import { MarkdownService } from '../services/markdownService.js';
import { PandocPdfService } from '../services/pandocPdfService.js';
import { Scraper } from './scraper.js';
import { PythonMergeService } from '../services/PythonMergeService.js';
import { HttpResourceService } from '../services/httpResourceService.js';
import { resolvePdfLayout } from '../services/pdf/layouts/layoutRegistry.js';

const SCRAPER_DEPENDENCIES = [
  'config',
  'logger',
  'browserPool',
  'pageManager',
  'fileService',
  'pathService',
  'metadataService',
  'stateManager',
  'progressTracker',
  'queueManager',
  'imageService',
  'pdfStyleService',
  'translationService',
  'annotationService',
  'markdownService',
  'markdownToPdfService',
  'httpResourceService',
];

function registerSingleton(container, name, factory, dependencies = []) {
  container.register(name, factory, {
    singleton: true,
    dependencies,
    lifecycle: 'singleton',
  });
}

function registerFoundationServices(container, setupLogger) {
  registerSingleton(container, 'config', async () => {
    const configLoader = new ConfigLoader();
    const config = await configLoader.load();
    setupLogger.info('Configuration loaded and validated');
    return config;
  });
  registerSingleton(container, 'processRunner', () => new ProcessRunner());
  registerSingleton(container, 'logger', () => createLogger('App'));
  registerSingleton(container, 'fileService', (logger) => new FileService(logger), ['logger']);
  registerSingleton(container, 'pathService', (config) => new PathService(config), ['config']);
  registerSingleton(
    container,
    'metadataService',
    (fileService, pathService, logger) => new MetadataService(fileService, pathService, logger),
    ['fileService', 'pathService', 'logger']
  );
}

function registerStateServices(container) {
  registerSingleton(
    container,
    'stateManager',
    async (fileService, pathService, logger, config) => {
      const stateManager = new StateManager(fileService, pathService, logger, config?.state);
      await stateManager.load();
      return stateManager;
    },
    ['fileService', 'pathService', 'logger', 'config']
  );
  registerSingleton(
    container,
    'progressTracker',
    (logger) => new ProgressTracker(logger),
    ['logger']
  );
  registerSingleton(
    container,
    'queueManager',
    (config, logger) => new QueueManager({
      concurrency: config.concurrency,
      timeout: config.queue?.timeout,
      logger,
    }),
    ['config', 'logger']
  );
}

function registerBrowserServices(container) {
  registerSingleton(
    container,
    'browserPool',
    (config, logger) => new BrowserPool({
      maxBrowsers: config.concurrency,
      headless: true,
      disableWebSecurity: config.browser?.disableWebSecurity === true,
      logger,
    }),
    ['config', 'logger']
  );
  registerSingleton(
    container,
    'pageManager',
    (browserPool, config, logger) => new PageManager(browserPool, {
      logger,
      userAgent: config.browser?.userAgent,
      ...config.browser,
    }),
    ['browserPool', 'config', 'logger']
  );
}

function createPdfStyleService(config) {
  const pdfConfig = config.pdf || {};
  return new PDFStyleService({
    theme: pdfConfig.theme || 'light',
    preserveCodeHighlighting: pdfConfig.preserveCodeHighlighting !== false,
    enableCodeWrap: pdfConfig.enableCodeWrap !== false,
    fontSize: pdfConfig.fontSize || '14px',
    fontFamily: pdfConfig.fontFamily || 'system-ui, -apple-system, sans-serif',
    codeFont:
      pdfConfig.codeFont || 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
    removeSelectors: config.removeSelectors || [],
  });
}

function registerContentServices(container) {
  registerSingleton(container, 'pdfLayout', (config) => resolvePdfLayout(config), ['config']);
  registerSingleton(container, 'httpResourceService', (config, logger) => new HttpResourceService({ config, logger }), ['config', 'logger']);
  registerSingleton(
    container,
    'imageService',
    (config, logger) => new ImageService({
      defaultTimeout: config.imageTimeout || 15000,
      logger,
    }),
    ['config', 'logger']
  );
  registerSingleton(container, 'pdfStyleService', createPdfStyleService, ['config']);
  registerSingleton(
    container,
    'translationService',
    (config, pathService, logger) => new TranslationService({ config, pathService, logger }),
    ['config', 'pathService', 'logger']
  );
  registerSingleton(
    container,
    'annotationService',
    (config, pathService, logger, processRunner) => new AnnotationService({
      config,
      pathService,
      logger,
      processRunner,
    }),
    ['config', 'pathService', 'logger', 'processRunner']
  );
  registerSingleton(
    container,
    'markdownService',
    (config, logger) => new MarkdownService({ config, logger }),
    ['config', 'logger']
  );
  registerSingleton(
    container,
    'markdownToPdfService',
    (config, logger, metadataService, processRunner, httpResourceService, pdfLayout) => new PandocPdfService({
      httpResourceService,
      processRunner,
      config,
      logger,
      metadataService,
      layout: pdfLayout,
    }),
    ['config', 'logger', 'metadataService', 'processRunner', 'httpResourceService', 'pdfLayout']
  );
}

async function createScraper(...dependencies) {
  const resolvedDependencies = Object.fromEntries(
    SCRAPER_DEPENDENCIES.map((name, index) => [name, dependencies[index]])
  );
  const scraper = new Scraper(resolvedDependencies);
  await scraper.initialize();
  return scraper;
}

function registerApplicationServices(container) {
  registerSingleton(container, 'scraper', createScraper, SCRAPER_DEPENDENCIES);
  registerSingleton(
    container,
    'pythonMergeService',
    (config, logger, processRunner) => new PythonMergeService(config, logger, processRunner),
    ['config', 'logger', 'processRunner']
  );
}

function registerServices(container, logger) {
  registerFoundationServices(container, logger);
  registerStateServices(container);
  registerBrowserServices(container);
  registerContentServices(container);
  registerApplicationServices(container);
}

async function preloadCriticalServices(container) {
  for (const serviceName of ['config', 'logger', 'fileService', 'pathService', 'pdfLayout']) {
    await container.get(serviceName);
  }
}

/**
 * 设置依赖注入容器
 * @returns {Promise<Container>} 配置好的容器实例
 */
async function setupContainer() {
  const container = new Container();
  const logger = createLogger('Setup');

  try {
    logger.info('Setting up dependency injection container...');
    registerServices(container, logger);
    container.validateDependencies();

    logger.info('Pre-loading critical services...');
    await preloadCriticalServices(container);

    logger.info('Container setup completed successfully');
    logger.info('Container statistics:', container.getStats());
    return container;
  } catch (error) {
    logger.error('Failed to setup container:', error);
    try {
      await container.dispose();
    } catch (disposeError) {
      logger.error('Error disposing container during setup failure:', disposeError);
    }
    throw error;
  }
}

/**
 * 创建预配置的容器实例
 * @returns {Promise<Container>} 配置好的容器实例
 */
async function createContainer() {
  return setupContainer();
}

/**
 * 获取容器健康检查信息
 * @param {Container} container - 容器实例
 * @returns {Object} 健康检查结果
 */
function getContainerHealth(container) {
  return container.getHealth();
}

/**
 * 安全地关闭容器
 * @param {Container} container - 容器实例
 */
async function shutdownContainer(container) {
  const logger = createLogger('Shutdown');

  try {
    logger.info('Shutting down container...');
    await container.dispose();
    logger.info('Container shutdown completed');
  } catch (error) {
    logger.error('Error during container shutdown:', error);
    throw error;
  }
}

export { setupContainer, createContainer, getContainerHealth, shutdownContainer };
