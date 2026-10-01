// src/services/stateManager.js
import { EventEmitter } from 'events';
import { createHash } from 'node:crypto';
import {
  ANNOTATION_CONTRACT_VERSION,
  ANNOTATION_RENDER_VERSION,
} from './annotationContract.js';
import { stableJson } from '../utils/object.js';

export class StateManager extends EventEmitter {
  constructor(fileService, pathService, logger, options = {}) {
    super();
    this.fileService = fileService;
    this.pathService = pathService;
    this.logger = logger;

    // 内存中的状态
    this.state = {
      processedUrls: new Set(), // 已处理的URL
      failedUrls: new Map(), // 失败的URL及错误信息
      urlToIndex: new Map(), // URL到索引的映射
      indexToUrl: new Map(), // 索引到URL的映射
      imageLoadFailures: new Set(), // 图片加载失败的URL
      urlToFile: new Map(), // URL到文件路径的映射
      startTime: null, // 开始时间
      lastSaveTime: null, // 最后保存时间
    };

    // 自动保存配置
    this.autoSaveInterval = options.saveInterval ?? 30000;
    this.persistFailures = options.persistFailures !== false;
    this.autoSaveTimer = null;
    this.savePromise = Promise.resolve();
    this.runIdentity = null;
    this.artifactHashes = new Map();
  }

  /**
   * 从磁盘加载状态
   */
  async load() {
    try {
      this.logger.info('加载状态数据...');

      // 加载进度数据
      const progress = await this.fileService.readJson(
        this.pathService.getMetadataPath('progress'),
        {
          processedUrls: [],
          failedUrls: [],
          urlToIndex: {},
          startTime: null,
        }
      );

      this.reset();
      this.runIdentity = progress.runIdentity || null;

      // 恢复Set和Map数据结构
      progress.processedUrls.forEach((url) => this.state.processedUrls.add(url));
      progress.failedUrls.forEach(({ url, error }) => this.state.failedUrls.set(url, error));

      // 恢复URL映射
      if (progress.urlToIndex) {
        Object.entries(progress.urlToIndex).forEach(([url, index]) => {
          this.state.urlToIndex.set(url, index);
          this.state.indexToUrl.set(index, url);
        });
      }

      // 恢复开始时间
      this.state.startTime = progress.startTime ? new Date(progress.startTime) : null;

      // 加载图片加载失败记录
      const imageFailures = await this.fileService.readJson(
        this.pathService.getMetadataPath('imageLoadFailures'),
        []
      );
      imageFailures.forEach(({ url }) => this.state.imageLoadFailures.add(url));

      // 加载URL到文件的映射
      const urlMapping = await this.fileService.readJson(
        this.pathService.getMetadataPath('urlMapping'),
        {}
      );
      // Versioned progress is the atomic source of truth; sidecars are legacy exports.
      Object.entries(progress.artifacts || urlMapping).forEach(([url, data]) => {
        this.state.urlToFile.set(url, data.path);
        if (data.sha256) this.artifactHashes.set(url, data.sha256);
      });

      this._enforceDisjointState('load');

      this.logger.info('状态加载完成', {
        已处理: this.state.processedUrls.size,
        失败: this.state.failedUrls.size,
      });

      this.emit('loaded', this.getStats());
    } catch (error) {
      this.reset();
      this.logger.warn('状态加载失败，使用空状态', { error: error.message });
      this.emit('load-error', error);
    }
  }

  /**
   * 保存状态到磁盘
   */
  async save(force = false) {
    const pending = this.savePromise.then(() => this._save(force));
    this.savePromise = pending.catch(() => {});
    return pending;
  }

  async _save(force) {
    try {
      const now = Date.now();

      // 如果不是强制保存，检查是否需要保存
      if (!force && this.state.lastSaveTime && now - this.state.lastSaveTime < 5000) {
        return; // 5秒内已保存过
      }

      this.logger.debug('保存状态数据...');

      // 兜底修复历史脏状态，保证 processed/failed 永远互斥
      this._enforceDisjointState('save');

      // 保存进度数据
      const urlToIndexObj = {};
      this.state.urlToIndex.forEach((index, url) => {
        urlToIndexObj[url] = index;
      });

      const progress = {
        version: 2,
        runIdentity: this.runIdentity,
        artifacts: Object.fromEntries([...this.state.urlToFile].map(([url, path]) => [url, {
          path, sha256: this.artifactHashes.get(url),
        }])),
        processedUrls: Array.from(this.state.processedUrls),
        failedUrls: (this.persistFailures ? Array.from(this.state.failedUrls.entries()) : []).map(([url, error]) => ({
          url,
          error,
        })),
        urlToIndex: urlToIndexObj,
        startTime: this.state.startTime,
        savedAt: new Date().toISOString(),
        stats: this.getStats(),
      };

      // 保存图片加载失败记录
      const imageFailures = Array.from(this.state.imageLoadFailures).map((url) => ({
        url,
        timestamp: new Date().toISOString(),
      }));
      await this.fileService.writeJson(
        this.pathService.getMetadataPath('imageLoadFailures'),
        imageFailures
      );

      // 保存URL映射
      const urlMapping = {};
      this.state.urlToFile.forEach((path, url) => {
        urlMapping[url] = {
          path,
          timestamp: new Date().toISOString(),
        };
      });
      await this.fileService.writeJson(this.pathService.getMetadataPath('urlMapping'), urlMapping);
      // Commit last: failures never publish a partially written new checkpoint.
      await this.fileService.writeJson(this.pathService.getMetadataPath('progress'), progress);

      this.state.lastSaveTime = now;
      this.logger.debug('状态保存完成');
      this.emit('saved', this.getStats());
    } catch (error) {
      this.logger.error('状态保存失败', { error: error.message });
      this.emit('save-error', error);
      if (force) throw error;
    }
  }

  /**
   * 保证 processedUrls 与 failedUrls 互斥（失败优先）
   * 历史版本可能写入重叠状态，这里在 load/save 时自动修复
   */
  _enforceDisjointState(source = 'runtime') {
    const overlappedUrls = [];
    this.state.failedUrls.forEach((_, url) => {
      if (this.state.processedUrls.has(url)) {
        overlappedUrls.push(url);
      }
    });

    if (overlappedUrls.length === 0) {
      return 0;
    }

    overlappedUrls.forEach((url) => {
      this.state.processedUrls.delete(url);
      this.state.urlToFile.delete(url);
    });

    this.logger.warn('检测到状态重叠，按失败优先修复', {
      来源: source,
      重叠数量: overlappedUrls.length,
      示例: overlappedUrls.slice(0, 5),
    });

    return overlappedUrls.length;
  }

  /**
   * 启动自动保存
   */
  startAutoSave() {
    if (this.autoSaveTimer) {
      return;
    }

    this.autoSaveTimer = setInterval(() => {
      this.save().catch((error) => this.logger.error('自动保存失败', { error: error.message }));
    }, this.autoSaveInterval);
    this.autoSaveTimer.unref?.();

    this.logger.info('启动自动保存', {
      间隔: `${this.autoSaveInterval / 1000}秒`,
    });
  }

  /**
   * 停止自动保存
   */
  stopAutoSave() {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
      this.logger.info('停止自动保存');
    }
  }

  /**
   * 记录URL和索引的映射
   */
  setUrlIndex(url, index) {
    this.state.urlToIndex.set(url, index);
    this.state.indexToUrl.set(index, url);
  }

  /** A checkpoint belongs to one ordered selection and acquisition configuration. */
  async prepareRun(urls, config, options = {}) {
    await this.savePromise;
    const acquisition = { ...config };
    for (const key of ['_runtime', 'logLevel', 'concurrency', 'network', 'queue', 'state',
      'python', 'output', 'retryFailedUrls', 'maxRetries', 'retryDelay', 'pageTimeout']) delete acquisition[key];
    if (config.markdown?.enabled && config.markdownPdf?.enabled && config.markdownPdf.batchMode) {
      delete acquisition.pdf;
      acquisition.markdownPdf = { enabled: true, batchMode: true };
    }
    if (acquisition.annotations?.enabled) {
      acquisition.annotations = {
        ...acquisition.annotations,
        contractVersion: options.annotationContractVersion || ANNOTATION_CONTRACT_VERSION,
        renderVersion: options.annotationRenderVersion || ANNOTATION_RENDER_VERSION,
      };
    }
    const identity = createHash('sha256').update(stableJson({ version: 1, urls, acquisition })).digest('hex');
    const resumed = this.runIdentity === identity;
    if (!resumed) this.reset();
    this.runIdentity = identity;
    this.state.urlToIndex.clear();
    this.state.indexToUrl.clear();
    urls.forEach((url, index) => this.setUrlIndex(url, index));
    return resumed;
  }

  async recordArtifact(url, filePath) {
    const hash = await this.fileService.hashFile(filePath);
    this.artifactHashes.set(url, hash);
    this.markProcessed(url, filePath);
  }

  async canResume(url) {
    if (!this.isProcessed(url) || !this.artifactHashes.has(url)) return false;
    try {
      if (await this.fileService.hashFile(this.state.urlToFile.get(url)) === this.artifactHashes.get(url)) return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.state.processedUrls.delete(url);
    this.state.urlToFile.delete(url);
    this.artifactHashes.delete(url);
    return false;
  }

  async getArtifacts() {
    const artifacts = [];
    for (const [url, index] of this.state.urlToIndex) {
      if (!await this.canResume(url)) throw new Error(`Missing or changed artifact: ${url}`);
      artifacts.push({ url, index: String(index), path: this.state.urlToFile.get(url), sha256: this.artifactHashes.get(url) });
    }
    if (artifacts.length === 0) throw new Error('No current-run artifacts');
    return artifacts.sort((a, b) => Number(a.index) - Number(b.index));
  }

  /**
   * 检查URL是否已处理
   */
  isProcessed(url) {
    return this.state.processedUrls.has(url);
  }

  /**
   * 标记URL为已处理
   */
  markProcessed(url, filePath = null) {
    this.state.processedUrls.add(url);
    this.state.failedUrls.delete(url); // 如果之前失败过，现在成功了

    if (filePath) {
      this.state.urlToFile.set(url, filePath);
    }

    this.emit('url-processed', { url, total: this.state.processedUrls.size });
  }

  /**
   * 标记URL为失败
   */
  markFailed(url, error) {
    const errorMessage = error?.message || String(error);
    this.state.processedUrls.delete(url);
    this.state.urlToFile.delete(url);
    this.artifactHashes.delete(url);
    this.state.failedUrls.set(url, errorMessage);
    this.emit('url-failed', { url, error: errorMessage });
  }

  /**
   * 获取失败的URL列表
   */
  getFailedUrls() {
    return Array.from(this.state.failedUrls.entries());
  }

  /**
   * 清除失败记录（用于重试）
   */
  clearFailure(url) {
    this.state.failedUrls.delete(url);
    this.state.processedUrls.delete(url);
  }

  /**
   * 标记图片加载失败
   */
  markImageLoadFailure(url) {
    this.state.imageLoadFailures.add(url);
    this.emit('image-load-failure', { url });
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const total = this.state.urlToIndex.size;
    const processed = this.state.processedUrls.size;
    const failed = this.state.failedUrls.size;
    const pending = Math.max(0, total - processed - failed);

    return {
      total,
      processed,
      failed,
      pending,
      imageLoadFailures: this.state.imageLoadFailures.size,
      successRate: total > 0 ? ((processed / total) * 100).toFixed(2) : 0,
      startTime: this.state.startTime,
      elapsed: this.state.startTime ? Date.now() - this.state.startTime : 0,
    };
  }

  /**
   * 重置状态
   */
  reset() {
    this.runIdentity = null;
    this.artifactHashes.clear();
    this.state.processedUrls.clear();
    this.state.failedUrls.clear();
    this.state.urlToIndex.clear();
    this.state.indexToUrl.clear();
    this.state.imageLoadFailures.clear();
    this.state.urlToFile.clear();
    this.state.startTime = null;
    this.state.lastSaveTime = null;

    this.emit('reset');
  }

  /**
   * 设置开始时间
   */
  setStartTime() {
    this.state.startTime = Date.now();
  }

  /**
   * 导出状态报告
   */
  async exportReport(outputPath) {
    const report = {
      summary: this.getStats(),
      failedUrls: Array.from(this.state.failedUrls.entries()).map(([url, error]) => ({
        url,
        error,
      })),
      imageLoadFailures: Array.from(this.state.imageLoadFailures),
      processedFiles: Array.from(this.state.urlToFile.entries()).map(([url, path]) => ({
        url,
        path,
      })),
      generatedAt: new Date().toISOString(),
    };

    await this.fileService.writeJson(outputPath, report);
    this.logger.info('导出状态报告', { path: outputPath });

    return report;
  }
}
