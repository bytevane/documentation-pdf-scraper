import fs from 'node:fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { constants as osConstants } from 'node:os';
import { checkToolchain } from './utils/toolchain.js';
import { createContainer, shutdownContainer, getContainerHealth } from './core/setup.js';
import { createLogger } from './utils/logger.js';
import { verifyPdf } from './services/pdf/pdfVerification.js';

/**
 * 主应用程序类
 * 提供完整的应用程序生命周期管理
 */
class Application {
  constructor(options = {}) {
    const { setupSignalHandlers = true, processRef = process } = options;

    this.container = null;
    this.logger = createLogger('Application');
    this.processRunner = null;
    this.isShuttingDown = false;
    this.startTime = null;
    this.processRef = processRef;

    // 绑定信号处理
    if (setupSignalHandlers) {
      this.setupSignalHandlers();
    }
  }

  /**
   * 设置信号处理器，实现优雅关闭
   */
  setupSignalHandlers() {
    const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

    signals.forEach((signal) => {
      this.processRef.on(signal, async () => {
        this.logger.info(`Received ${signal}, initiating graceful shutdown...`);
        await this.shutdown();
        // Conventional "terminated by signal" exit code, e.g. 130 for SIGINT.
        this.processRef.exit(128 + osConstants.signals[signal]);
      });
    });

    // 处理未捕获的异常
    this.processRef.on('uncaughtException', async (error) => {
      this.logger.error('Uncaught exception:', error);
      await this.shutdown();
      this.processRef.exit(1);
    });

    // 处理未处理的Promise拒绝
    this.processRef.on('unhandledRejection', async (reason, promise) => {
      this.logger.error('Unhandled promise rejection:', { reason, promise });
      await this.shutdown();
      this.processRef.exit(1);
    });
  }

  /**
   * 初始化应用程序
   */
  async initialize() {
    if (this.container) return;
    try {
      this.startTime = Date.now();
      this.logger.info('🚀 Starting PDF Scraper Application...');

      // 1. 创建依赖注入容器
      this.logger.info('📦 Setting up dependency injection container...');
      this.container = await createContainer();

      this.processRunner = await this.container.get('processRunner');

      // 5. 验证容器健康状态
      const health = getContainerHealth(this.container);
      this.logger.info('🏥 Container health check:', health);

      const initTime = Date.now() - this.startTime;
      this.logger.info(`✅ Application initialized successfully in ${initTime}ms`);
    } catch (error) {
      this.logger.error('❌ Failed to initialize application:', error);
      await this.cleanup();
      throw error;
    }
  }

  /**
   * 运行爬虫任务
   */
  async runScraping() {
    try {
      this.logger.info('🕷️  Starting web scraping process...');
      const scrapeStartTime = Date.now();

      // 获取必要的服务
      const scraper = await this.container.get('scraper');
      const progressTracker = await this.container.get('progressTracker');
      const fileService = await this.container.get('fileService');
      const config = await this.container.get('config');

      // 清理和准备PDF目录
      this.logger.info('🧹 Preparing PDF directory...');
      // await fileService.cleanDirectory(config.pdfDir); // Don't clean on start to allow resume
      await fileService.ensureDirectory(config.pdfDir);

      // 执行爬虫任务
      await scraper.run();

      // 获取爬虫统计信息
      const stats = progressTracker.getStats();
      if (stats.failed > 0) throw new Error(`${stats.failed} documentation pages failed`);
      const scrapeTime = Date.now() - scrapeStartTime;

      this.logger.info('✅ Web scraping completed successfully', {
        duration: scrapeTime,
        stats,
      });

      return {
        success: true,
        duration: scrapeTime,
        stats,
      };
    } catch (error) {
      this.logger.error('❌ Web scraping failed:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 运行Python PDF合并
   */
  async runPythonMerge() {
    try {
      this.logger.info('📄 Starting PDF merge process...');
      const mergeStartTime = Date.now();

      const pythonMergeService = await this.container.get('pythonMergeService');

      const config = await this.container.get('config');

      // 为 Python 合并生成完整配置文件（config.json 仅保留公共配置，doc-target 在运行时合并）
      const tempDirectory = path.resolve(config.output?.tempDirectory || '.temp');
      const rootDir = path.resolve(process.cwd());
      const relativeTemp = path.relative(rootDir, tempDirectory);
      if (relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp)) {
        throw new Error(`Unsafe temp directory: ${tempDirectory}`);
      }

      await fs.mkdir(tempDirectory, { recursive: true });

      const mergedConfigPath = path.join(
        tempDirectory,
        `merged_config_${process.pid}_${Date.now()}.json`
      );
      await fs.writeFile(mergedConfigPath, JSON.stringify(config, null, 2), 'utf8');

      // 使用新的Python合并服务
      let result;
      try {
        result = await pythonMergeService.mergePDFs(
          { config: mergedConfigPath }
        );
      } finally {
        try {
          await fs.unlink(mergedConfigPath);
        } catch {
          // ignore cleanup errors
        }
      }

      const mergeTime = Date.now() - mergeStartTime;

      if (result.success) {
        this.logger.info('✅ PDF merge completed successfully', {
          duration: mergeTime,
          outputFiles: result.mergedFiles,
          processedFiles: result.filesProcessed,
        });
      } else {
        this.logger.error('❌ PDF merge failed:', result.error);
      }

      return {
        ...result,
        duration: mergeTime,
      };
    } catch (error) {
      this.logger.error('❌ PDF merge process failed:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 运行批量PDF生成（跳过Python合并，直接从markdown生成最终PDF）
   */
  async runBatchPdfGeneration() {
    try {
      this.logger.info('📄 Starting batch PDF generation (direct from markdown)...');
      const batchStartTime = Date.now();

      const config = await this.container.get('config');
      const markdownToPdfService = await this.container.get('markdownToPdfService');
      const stateManager = await this.container.get('stateManager');
      const artifacts = await stateManager.getArtifacts();

      const pdfDir = config.pdfDir || 'pdfs';
      const markdownDir = path.join(pdfDir, config.markdown?.outputDir || 'markdown');

      // Generate output filename
      const url = new URL(config.rootURL);
      const domain = url.hostname.replace(/\./g, '_');
      const currentDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const timestamp = Date.now().toString().slice(-6);

      const finalPdfDir = path.join(pdfDir, config.output?.finalPdfDirectory || 'finalPdf');
      const outputPath = path.join(finalPdfDir, `${domain}_batch_${currentDate}_${timestamp}.pdf`);

      const result = await markdownToPdfService.generateBatchPdf(
        markdownDir,
        outputPath,
        { ...config.markdownPdf, artifacts }
      );

      const batchTime = Date.now() - batchStartTime;

      if (result.success) {
        this.logger.info('✅ Batch PDF generation completed successfully', {
          duration: batchTime,
          outputFile: result.outputPath,
          filesProcessed: result.filesProcessed,
        });
      } else {
        this.logger.error('❌ Batch PDF generation failed');
      }

      return {
        ...result,
        duration: batchTime,
      };
    } catch (error) {
      this.logger.error('❌ Batch PDF generation process failed:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 运行完整的应用程序流程
   */
  async run() {
    try {
      await this.initialize();

      const totalStartTime = Date.now();
      this.logger.info('🎯 Starting complete PDF scraping and merge workflow...');

      // 1. 执行网页爬虫
      const scrapeResult = await this.runScraping();
      if (!scrapeResult.success) {
        throw new Error(`Scraping failed: ${scrapeResult.error}`);
      }

      // 2. 执行PDF生成（根据配置选择批量模式或Python合并）
      const config = await this.container.get('config');
      const useBatchMode = config.markdownPdf?.batchMode === true;

      let mergeResult;
      if (useBatchMode) {
        this.logger.info('📦 Using batch mode - generating PDF directly from markdown...');
        mergeResult = await this.runBatchPdfGeneration();
      } else {
        this.logger.info('📦 Using standard mode - merging individual PDFs via Python...');
        mergeResult = await this.runPythonMerge();
      }

      if (!mergeResult.success) {
        throw new Error(
          `PDF generation failed: ${mergeResult.error || 'Unknown PDF generation error'}`
        );
      }

      const pdfPaths = useBatchMode ? [mergeResult.outputPath] : mergeResult.mergedFiles;
      const verification = await this.runPdfVerification(pdfPaths, config);
      const totalTime = Date.now() - totalStartTime;

      // 生成最终报告
      const finalReport = {
        totalDuration: totalTime,
        scraping: scrapeResult,
        merge: mergeResult,
        verification,
        batchMode: useBatchMode,
        timestamp: new Date().toISOString(),
      };

      this.logger.info('🎉 Application workflow completed!', finalReport);

      return finalReport;
    } catch (error) {
      this.logger.error('💥 Application workflow failed:', error);
      throw error;
    }
  }

  async runPdfVerification(pdfPaths, config) {
    if (!Array.isArray(pdfPaths) || !pdfPaths.length || pdfPaths.some((file) => !file)) {
      throw new Error('PDF generation returned no output paths');
    }
    const metadata = await this.container.get('metadataService');
    const titles = Object.values(await metadata.getArticleTitles());
    const structure = await metadata.getSectionStructure();
    const results = [];
    for (const pdfPath of pdfPaths) {
      results.push(await verifyPdf(pdfPath, {
        config, processRunner: this.processRunner,
        expectations: {
          candidateTitles: titles,
          articleTitles: config.markdownPdf?.batchMode && config.markdownPdf.toc !== false ? titles : [],
          groups: config.markdownPdf?.batchMode
            ? (structure?.sections || []).map((section) => section.title) : [],
        },
      }));
    }
    const foundTitles = new Set(results.flatMap((result) => result.foundTitles));
    const missingTitles = titles.filter((title) => !foundTitles.has(title));
    if (missingTitles.length) throw new Error(`PDFs are missing article titles: ${missingTitles.join(', ')}`);
    this.logger.info('PDF 自动检查通过；页面预览仍需人工检查', { results });
    return results;
  }

  /**
   * 获取应用程序状态
   */
  getStatus() {
    const uptime = this.startTime ? Date.now() - this.startTime : 0;

    return {
      status: this.isShuttingDown ? 'shutting_down' : 'running',
      uptime,
      startTime: this.startTime,
      containerHealth: this.container ? getContainerHealth(this.container) : null,
      processes: this.processRunner ? this.processRunner.getRunningProcesses() : [],
      memoryUsage: this.processRef.memoryUsage(),
      pid: this.processRef.pid,
    };
  }

  /**
   * 清理资源
   */
  async cleanup() {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    this.logger.info('🧹 Starting application cleanup...');

    try {
      // Stop all external commands before disposing their services.
      if (this.processRunner) {
        await this.processRunner.dispose();
        this.processRunner = null;
      }

      // 2. 关闭容器和所有服务
      if (this.container) {
        await shutdownContainer(this.container);
        this.container = null;
      }

      this.logger.info('✅ Application cleanup completed');
    } catch (error) {
      this.logger.error('❌ Error during cleanup:', error);
    }
  }

  /**
   * 优雅关闭
   */
  async shutdown() {
    if (this.isShuttingDown) {
      return;
    }

    const shutdownStartTime = Date.now();
    this.logger.info('🛑 Initiating graceful shutdown...');

    try {
      await this.cleanup();

      const shutdownTime = Date.now() - shutdownStartTime;
      this.logger.info(`✅ Graceful shutdown completed in ${shutdownTime}ms`);
    } catch (error) {
      this.logger.error('❌ Error during shutdown:', error);
    }
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    try {
      const status = this.getStatus();
      return {
        healthy: true,
        status: status.status,
        uptime: status.uptime,
        containerHealth: status.containerHealth,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }
}

/**
 * 主入口函数
 */
async function main() {
  const app = new Application();

  try {
    // 运行应用程序
    await app.initialize();
    const config = await app.container.get('config');
    app.logger.info('Toolchain preflight', await checkToolchain(config, app.processRunner));
    const result = await app.run();

    console.log('\n' + '='.repeat(60));
    console.log('🎉 APPLICATION COMPLETED SUCCESSFULLY');
    console.log('='.repeat(60));
    console.log(`📊 Total Duration: ${result.totalDuration}ms`);
    console.log(`🕷️  Scraping: ${result.scraping.success ? '✅ Success' : '❌ Failed'}`);
    console.log(`📄 PDF Merge: ${result.merge.success ? '✅ Success' : '❌ Failed'}`);
    console.log('='.repeat(60));

    // 优雅关闭
    await app.shutdown();

    process.exit(0);
  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('💥 APPLICATION FAILED');
    console.error('='.repeat(60));
    console.error('Error:', error.message);
    console.error('='.repeat(60));

    // 确保清理资源
    await app.cleanup();

    process.exit(1);
  }
}

// 导出应用程序类和主函数
export { Application, main };

// 如果直接运行此文件，执行主函数
const entryFilePath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (entryFilePath === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
