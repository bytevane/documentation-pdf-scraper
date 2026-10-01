// src/services/pathService.js
import path from 'path';
import { getUrlHash, extractSubfolder } from '../utils/url.js';

export class PathService {
  constructor(config) {
    this.config = config;
  }

  /**
   * 确定PDF文件的存储目录
   */
  determineDirectory(url) {
    const match = extractSubfolder(url);
    if (match) {
      const prefix = `${match.type}-`;
      return path.join(this.config.pdfDir, `${prefix}${match.name}`);
    }

    // 如果URL不匹配已知模式，使用主机名
    try {
      const hostname = new URL(url).hostname;
      return path.join(this.config.pdfDir, `${hostname}-docs`);
    } catch {
      return path.join(this.config.pdfDir, 'misc-docs');
    }
  }

  /**
   * 获取PDF文件的完整路径
   */
  getPdfPath(url, options = {}) {
    const { useHash = true, index = null } = options;

    // 提取文件名
    let fileName =
      url
        .split('/')
        .filter((s) => s)
        .pop() || 'index';

    // 清理文件名中的特殊字符
    fileName = fileName.replace(/[^a-zA-Z0-9-_]/g, '-');

    // 确定目录
    const directory = this.determineDirectory(url);

    // 构建文件名 - 数字索引优先，带补零
    let finalFileName;

    if (!useHash && index !== null) {
      // 使用数字索引（3位补零确保正确排序）
      const paddedIndex = String(index).padStart(3, '0');
      finalFileName = `${paddedIndex}-${fileName}.pdf`;
    } else if (useHash) {
      // 使用哈希（向后兼容）
      const hash = getUrlHash(url);
      finalFileName = `${hash}-${fileName}.pdf`;
    } else {
      // 后备方案：直接使用文件名
      finalFileName = `${fileName}.pdf`;
    }

    return path.join(directory, finalFileName);
  }

  /**
   * 获取元数据文件路径
   */
  getMetadataPath(type) {
    const metadataFiles = {
      articleTitles: 'articleTitles.json',
      failed: 'failed.json',
      imageLoadFailures: 'imageLoadFailures.json',
      progress: 'progress.json',
      urlMapping: 'urlMapping.json',
      // 新增：分层TOC的section结构元数据文件
      sectionStructure: 'sectionStructure.json',
    };

    const fileName = metadataFiles[type];
    if (!fileName) {
      throw new Error(`未知的元数据类型: ${type}`);
    }

    return path.join(this.config.pdfDir, 'metadata', fileName);
  }

  /**
   * 解析PDF文件名，提取信息 - 改进：支持数字和哈希前缀
   */
  parsePdfFileName(fileName) {
    // 假设格式: 000-original-name.pdf 或 hash-original-name.pdf
    const nameWithoutExt = path.basename(fileName, '.pdf');
    const parts = nameWithoutExt.split('-');

    if (parts.length >= 2) {
      const prefix = parts[0];
      const originalName = parts.slice(1).join('-');

      // 判断是数字索引还是哈希
      const isNumericIndex = /^\d{3}$/.test(prefix); // 3位数字
      const isHash = /^[a-f0-9]{8}$/.test(prefix); // 8位十六进制哈希

      return {
        prefix,
        originalName,
        isNumericIndex,
        isHash,
        index: isNumericIndex ? parseInt(prefix, 10) : null,
      };
    }

    return {
      prefix: null,
      originalName: nameWithoutExt,
      isNumericIndex: false,
      isHash: false,
      index: null,
    };
  }

  /**
   * 获取临时目录路径
   */
  getTempDirectory() {
    const tempDir = this.config.output?.tempDirectory || '.temp';
    return path.resolve(tempDir);
  }

  /**
   * 获取翻译缓存目录
   * 确保路径位于当前工作目录之下，防止越界访问
   */
  getTranslationCacheDirectory() {
    const baseTempDir = this.getTempDirectory();
    const cacheDir = path.join(baseTempDir, 'translation_cache');

    const rootDir = path.resolve(process.cwd());
    const resolved = path.resolve(cacheDir);

    if (!resolved.startsWith(rootDir)) {
      throw new Error(`Unsafe translation cache directory: ${resolved}`);
    }

    return resolved;
  }

  /**
   * 获取英语批注缓存目录，并限制在当前工作目录之下。
   */
  getAnnotationCacheDirectory() {
    const baseTempDir = this.getTempDirectory();
    const cacheDir = path.join(baseTempDir, 'annotation_cache');

    const rootDir = path.resolve(process.cwd());
    const resolved = path.resolve(cacheDir);

    if (resolved !== rootDir && !resolved.startsWith(`${rootDir}${path.sep}`)) {
      throw new Error(`Unsafe annotation cache directory: ${resolved}`);
    }

    return resolved;
  }
}
