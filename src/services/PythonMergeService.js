/**
 * Python PDF合并服务集成类
 * 提供Node.js与Python PDF合并功能的桥接
 */

import { EventEmitter } from 'events';
import { ProcessRunner } from '../utils/processRunner.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class PythonMergeError extends Error {
  constructor(message, code = null, details = null) {
    super(message);
    this.name = 'PythonMergeError';
    this.code = code;
    this.details = details;
  }
}

export class PythonMergeService extends EventEmitter {
  /**
   * Python PDF合并服务类
   *
   * 特性：
   * - 集成Python PDF合并功能
   * - 异步执行和进度监控
   * - 完整的错误处理和恢复
   * - 与Node.js服务架构无缝集成
   * - 支持配置驱动和环境变量
   */

  constructor(config = {}, logger = null, processRunner = new ProcessRunner()) {
    super();

    this.config = config;
    this.processRunner = processRunner;
    this.logger = logger || createLogger('PythonMergeService');

    // Python脚本路径
    this.pythonScriptDir = path.join(__dirname, '..', 'python');
    this.mergerScript = path.join(this.pythonScriptDir, 'pdf_merger.py');

    // 运行时状态
    this.isRunning = false;
    this.mergeController = null;
    this.currentRun = null;
    this.statistics = {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      totalFilesProcessed: 0,
      totalPagesProcessed: 0,
      averageExecutionTime: 0,
      lastRunTime: null,
      errors: [],
    };

    // Python环境配置
    this.pythonConfig = {
      executable: config.python?.executable || 'python3',
      timeout: config.python?.timeout || 300000, // 5分钟超时
      maxBuffer: config.python?.maxBuffer || 1024 * 1024 * 10, // 10MB缓冲区
      encoding: 'utf-8',
    };

    this.logger.info('Python合并服务初始化完成');
  }

  /**
   * 执行PDF合并
   */
  async mergePDFs(options = {}) {
    if (this.isRunning) {
      throw new PythonMergeError('PDF合并任务正在运行中', 'TASK_ALREADY_RUNNING');
    }

    const startTime = Date.now();
    this.isRunning = true;
    this.statistics.totalRuns++;
    this.statistics.lastRunTime = new Date();

    try {
      this.emit('mergeStarted', { options, startTime });

      // 构建Python脚本参数
      const args = [this.mergerScript];

      if (options.config) {
        args.push('--config', options.config);
      }

      if (options.directory) {
        args.push('--directory', options.directory);
      }

      if (options.verbose) {
        args.push('--verbose');
      }

      this.logger.info(`开始PDF合并任务: ${args.join(' ')}`);

      // 执行Python脚本
      this.mergeController = new AbortController();
      this.currentRun = this._executePython(args, {
        signal: this.mergeController.signal,
        onStdout: (chunk) => this._parseProgress(chunk),
      });
      const result = await this.currentRun;

      // 解析结果
      const mergeResult = this._parseResult(result);

      // 更新统计信息
      this._updateStatistics(mergeResult, Date.now() - startTime);

      this.emit('mergeCompleted', {
        success: true,
        result: mergeResult,
        executionTime: Date.now() - startTime,
      });

      this.logger.info(`PDF合并任务完成: 处理 ${mergeResult.filesProcessed} 个文件`);

      return mergeResult;
    } catch (error) {
      this.statistics.failedRuns++;
      this.statistics.errors.push({
        timestamp: new Date(),
        error: error.message,
        options,
      });

      this.emit('mergeError', {
        error: error.message,
        options,
        executionTime: Date.now() - startTime,
      });

      this.logger.error(`PDF合并任务失败: ${error.message}`);
      throw error;
    } finally {
      this.isRunning = false;
      this.mergeController = null;
      this.currentRun = null;
    }
  }

  /**
   * 停止当前运行的合并任务
   */
  async stopMerge() {
    if (!this.mergeController) return false;
    this.mergeController.abort();
    await Promise.allSettled([this.currentRun]);
    this.emit('mergeStopped');
    this.logger.info('PDF合并任务已停止');
    return true;
  }

  /**
   * 获取运行状态
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      statistics: { ...this.statistics },
      config: this.pythonConfig,
    };
  }

  /**
   * 执行Python脚本
   */
  async _executePython(args, options = {}) {
    return this.processRunner.run(this.pythonConfig.executable, args, {
      timeoutMs: this.pythonConfig.timeout,
      maxBuffer: this.pythonConfig.maxBuffer,
      cwd: this.config.python?.cwd,
      env: { ...process.env, ...this.config.python?.env },
      failureLabel: 'Python execution failed',
      ...options,
    });
  }

  /**
   * 解析进度信息
   */
  _parseProgress(output) {
    // 查找进度模式，例如: "Progress: 3/10 files processed"
    const progressMatch = output.match(/Progress:\s*(\d+)\/(\d+)\s*files?\s*processed/i);
    if (progressMatch) {
      const current = parseInt(progressMatch[1]);
      const total = parseInt(progressMatch[2]);

      this.emit('progress', {
        current,
        total,
        percentage: Math.round((current / total) * 100),
      });
    }

    // 查找统计信息
    const statsMatch = output.match(/统计信息:|Statistics:/i);
    if (statsMatch) {
      this.emit('statistics', { output });
    }
  }

  /**
   * 解析Python脚本结果
   */
  _parseResult(result) {
    const lines = result.stdout.trim().split('\n');
    const parsed = JSON.parse(lines.at(-1));
    if (parsed.success !== true || !Array.isArray(parsed.mergedFiles)
        || parsed.mergedFiles.length === 0 || parsed.mergedFiles.some((file) => typeof file !== 'string' || !file)
        || !Number.isInteger(parsed.filesProcessed)
        || parsed.filesProcessed < 1 || !Number.isInteger(parsed.totalPages)
        || parsed.totalPages < 1) {
      throw new PythonMergeError('Invalid merge result', 'INVALID_RESULT', parsed);
    }
    return parsed;
  }

  /**
   * 更新统计信息
   */
  _updateStatistics(result, executionTime) {
    if (result.success) {
      this.statistics.successfulRuns++;
      this.statistics.totalFilesProcessed += result.filesProcessed || 0;
      this.statistics.totalPagesProcessed += result.totalPages || 0;

      // 更新平均执行时间
      const totalTime =
        this.statistics.averageExecutionTime * (this.statistics.successfulRuns - 1) + executionTime;
      this.statistics.averageExecutionTime = Math.round(totalTime / this.statistics.successfulRuns);
    }

    // 保持错误历史在合理范围内
    if (this.statistics.errors.length > 10) {
      this.statistics.errors = this.statistics.errors.slice(-10);
    }
  }

  /**
   * 清理资源
   */
  async dispose() {
    if (this.isRunning) {
      await this.stopMerge();
    }

    await this.processRunner.dispose();
    this.removeAllListeners();
    this.logger.info('Python合并服务已清理');
  }
}

export default PythonMergeService;
