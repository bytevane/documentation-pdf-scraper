// src/services/pandocPdfService.js
import { ProcessRunner } from '../utils/processRunner.js';
import { MarkdownNormalizer } from './pdf/markdownNormalizer.js';
import {
  englishAnnotationFilterPath,
  pandocHeader,
} from './pdf/pandocTemplate.js';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import pLimit from 'p-limit';
import { HttpResourceService } from './httpResourceService.js';
import { resolvePdfLayout } from './pdf/layouts/layoutRegistry.js';
import { PandocLayoutAdapter } from './pdf/layouts/pandocLayoutAdapter.js';
import { isPathInside } from '../utils/paths.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_CONTENT_TYPE_FORMATS = [
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
  ['image/gif', 'gif'],
  ['image/svg+xml', 'svg'],
  ['application/pdf', 'pdf'],
];
const IMAGE_SIGNATURE_DETECTORS = [
  {
    format: 'png',
    matches: (buffer) => buffer.length >= PNG_SIGNATURE.length
      && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
  },
  {
    format: 'jpg',
    matches: (buffer) => buffer.length >= 3
      && buffer[0] === 0xff
      && buffer[1] === 0xd8
      && buffer[2] === 0xff,
  },
  {
    format: 'svg',
    matches: (buffer) => buffer
      .subarray(0, Math.min(buffer.length, 512))
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .trimStart()
      .toLowerCase()
      .includes('<svg'),
  },
  {
    format: 'gif',
    matches: (buffer) => ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii')),
  },
  {
    format: 'webp',
    matches: (buffer) => buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    format: 'pdf',
    matches: (buffer) => buffer.subarray(0, 5).toString('ascii') === '%PDF-',
  },
  {
    format: 'avif',
    matches: (buffer) => buffer.length >= 12
      && buffer.subarray(4, 8).toString('ascii') === 'ftyp'
      && ['avif', 'avis'].includes(buffer.subarray(8, 12).toString('ascii')),
  },
];

/**
 * PandocPdfService
 * 使用 Pandoc 将 Markdown 内容或文件转换为 PDF
 * 内容规范化、排版模板与子进程生命周期由独立模块负责。
 */
export class PandocPdfService {
  constructor(options = {}) {
    this.logger = options.logger;
    this.config = options.config || {};
    this.normalizer = new MarkdownNormalizer(this.config);
    this.processRunner = options.processRunner || new ProcessRunner();
    this.pandocBinary = options.pandocBinary || 'pandoc';
    this.latexBinary = options.latexBinary || 'xelatex';
    this.metadataService = options.metadataService || null;
    this.layout = options.layout === undefined ? resolvePdfLayout(this.config) : options.layout;
    this.layoutAdapter = this.layout ? new PandocLayoutAdapter(this.layout) : null;
    this.httpResourceService = options.httpResourceService || new HttpResourceService({ config: this.config, logger: this.logger });
  }

  /**
   * 将 Markdown 文件转换为 PDF
   * @param {string} markdownPath
   * @param {string} outputPath
   * @param {Object} options
   */
  async convertToPdf(markdownPath, outputPath, options = {}) {
    try {
      this.logger?.info?.('开始使用 Pandoc 将 Markdown 文件转换为 PDF', {
        markdownPath,
        outputPath,
      });

      // 读取文件内容
      const content = fs.readFileSync(markdownPath, 'utf8');

      // 使用 convertContentToPdf 处理（它包含清理逻辑）
      await this.convertContentToPdf(content, outputPath, options);

      this.logger?.info?.('Pandoc Markdown 文件转换 PDF 完成', {
        outputPath,
      });
    } catch (error) {
      this.logger?.error?.('Pandoc Markdown 文件转换 PDF 失败', {
        markdownPath,
        outputPath,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 将 Markdown 文本内容转换为 PDF
   * @param {string} markdownContent
   * @param {string} outputPath
   * @param {Object} options
   */
  async convertContentToPdf(markdownContent, outputPath, options = {}) {
    return this._renderContent(this.normalizer._cleanMarkdownContent(markdownContent, options.sourceUrl), outputPath, options);
  }

  async _renderContent(content, outputPath, options) {
    const tempRoot = path.join(process.cwd(), '.temp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(tempRoot, 'render-'));
    try {
      const prepared = await this._preparePdfImages(content, tempDir);
      const inputPath = path.join(tempDir, 'input.md');
      fs.writeFileSync(inputPath, prepared.content, 'utf8');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      await this._runPandoc(inputPath, outputPath, options);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * 运行 Pandoc 命令
   * @param {string} inputPath
   * @param {string} outputPath
   * @param {Object} options
   * @returns {Promise<void>}
   * @private
   */
  async _runPandoc(inputPath, outputPath, options = {}) {
    const tempDir = path.dirname(inputPath) || process.cwd();
    const headerIncludePath = this._createPandocHeaderFile(tempDir);
    const latexWorkDir = fs.mkdtempSync(path.join(tempDir, 'pandoc-latex-'));
    const latexInputPath = path.join(latexWorkDir, 'input.tex');
    const latexOutputPath = path.join(latexWorkDir, 'input.pdf');
    const args = this._buildPandocLatexArgs(inputPath, latexInputPath, {
      ...options,
      headerIncludePath,
    });

    return (async () => {
      await this._runExternalCommand(this.pandocBinary, args, {
        failureLabel: 'Pandoc 转换失败',
        timeoutMs: 120000,
      });

      await this._runXeLatexUntilStable(latexInputPath, latexWorkDir);

      if (!fs.existsSync(latexOutputPath)) {
        throw new Error('PDF 文件未生成');
      }

      fs.copyFileSync(latexOutputPath, outputPath);
    })().finally(() => {
      try {
        fs.unlinkSync(headerIncludePath);
      } catch {
        // Ignore cleanup errors
      }

      try {
        fs.rmSync(latexWorkDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });
  }

  /**
   * 运行一个外部命令并在失败时附带 stderr，便于定位 Pandoc / XeLaTeX 问题。
   *
   * @param {string} command
   * @param {string[]} args
   * @param {{ failureLabel: string, timeoutMs?: number }} options
   * @returns {Promise<{stdout: string, stderr: string}>}
   * @private
   */
  async _runExternalCommand(command, args, options = {}) {
    return this.processRunner.run(command, args, options);
  }

  /**
   * 显式运行 XeLaTeX，确保 TOC / 引用在多轮编译中稳定收敛。
   *
   * @param {string} inputPath
   * @param {string} outputDir
   * @returns {Promise<void>}
   * @private
   */
  async _runXeLatex(inputPath, outputDir) {
    await this._runExternalCommand(
      this.latexBinary,
      [
        '-halt-on-error',
        '-no-shell-escape',
        '-interaction=nonstopmode',
        `-output-directory=${outputDir}`,
        inputPath,
      ],
      {
        failureLabel: 'XeLaTeX 转换失败',
        cwd: outputDir,
      }
    );
  }

  async _runXeLatexUntilStable(inputPath, outputDir) {
    const stem = path.basename(inputPath, path.extname(inputPath));
    let previousState;

    for (let pass = 1; pass <= 5; pass++) {
      await this._runXeLatex(inputPath, outputDir);
      const currentState = ['aux', 'toc', 'out'].map((extension) => {
        const filePath = path.join(outputDir, `${stem}.${extension}`);
        return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
      }).join('\n');

      if (pass > 1 && currentState === previousState) return;
      previousState = currentState;
    }

    throw new Error('XeLaTeX references did not stabilize after 5 passes');
  }

  /**
   * 将 Markdown 中仍不适合 XeLaTeX 直接处理的图片优先转换为本地 PNG；
   * 图片获取或转换失败时终止生成，不替换为链接。
   *
   * @param {string} content
   * @param {string} tempRootDir
   * @returns {Promise<{content: string, cleanupPaths: string[]}>}
   * @private
   */
  async _preparePdfImages(content, tempRootDir) {
    if (!content) {
      return { content, cleanupPaths: [] };
    }

    const urls = this.normalizer._extractPdfUnsafeImageUrls(content);
    if (urls.length === 0) {
      return { content, cleanupPaths: [] };
    }

    const mediaDir = path.join(tempRootDir, `media-${Date.now()}`);
    const resolvedUrls = new Map();
    const cleanupPaths = [mediaDir];

    try {
      const limit = pLimit(this.config.network?.imageConcurrency ?? 3);
      const results = await Promise.allSettled(urls.map((url) => limit(async () => {
        resolvedUrls.set(url, await this._materializePdfSafeImage(url, mediaDir));
      })));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    } catch (error) {
      fs.rmSync(mediaDir, { recursive: true, force: true });
      throw error;
    }

    const prepared = this.normalizer._mapProseSegments(content, (segment) =>
      this.normalizer._rewritePdfImagesInProse(segment, resolvedUrls)
    );

    return { content: prepared, cleanupPaths };
  }

  /**
   * 下载并转换远程图片为本地 PNG，供 Pandoc/XeLaTeX 稳定读取。
   *
   * @param {string} url
   * @param {string} mediaDir
   * @returns {Promise<string|null>}
   * @private
   */
  async _materializePdfSafeImage(url, mediaDir) {
    if (!url || !/^https?:\/\//i.test(url)) {
      return null;
    }

    fs.mkdirSync(mediaDir, { recursive: true });

    const digest = createHash('sha256').update(url).digest('hex').slice(0, 24);
    const outputPath = path.join(mediaDir, `${digest}.png`);

    if (fs.existsSync(outputPath)) {
      return outputPath;
    }

    const { contentType, buffer } = await this.httpResourceService.get(url, 'image');
    const detectedFormat = this._detectDownloadedImageFormat(buffer, contentType);
    const sourceExtension = this._getImageExtensionFromUrl(url, contentType, detectedFormat);
    const sourcePath = path.join(mediaDir, `${digest}${sourceExtension}`);
    const shouldConvert = this._shouldConvertDownloadedImage(url, contentType, detectedFormat);

    if (fs.existsSync(sourcePath)) {
      if (!shouldConvert) {
        return sourcePath;
      }

      await this._convertImageToPng(sourcePath, outputPath);
      return outputPath;
    }

    await fs.promises.writeFile(sourcePath, buffer);

    if (!shouldConvert) {
      return sourcePath;
    }

    await this._convertImageToPng(sourcePath, outputPath);
    return outputPath;
  }

  /**
   * 判断下载后的图片是否需要转为 PNG 才能稳定进入 XeLaTeX。
   *
   * @param {string} url
   * @param {string} contentType
   * @returns {boolean}
   * @private
   */
  _shouldConvertDownloadedImage(url, contentType = '', detectedFormat = '') {
    const normalizedFormat = detectedFormat.toLowerCase();
    const normalizedType = contentType.toLowerCase();

    if (normalizedFormat === 'png' || normalizedFormat === 'jpg' || normalizedFormat === 'jpeg') {
      return false;
    }

    if (normalizedFormat === 'pdf') {
      return false;
    }

    if (
      normalizedFormat === 'webp'
      || normalizedFormat === 'avif'
      || normalizedFormat === 'gif'
      || normalizedFormat === 'svg'
    ) {
      return true;
    }

    if (normalizedType.includes('image/png') || normalizedType.includes('image/jpeg')) {
      return false;
    }

    if (normalizedType.includes('application/pdf')) {
      return false;
    }

    if (normalizedType.includes('image/webp')) return true;
    if (normalizedType.includes('image/avif')) return true;
    if (normalizedType.includes('image/gif')) return true;
    if (normalizedType.includes('image/svg+xml')) return true;

    return this._isPdfUnsafeImageUrl(url);
  }

  /**
   * 根据真实下载内容识别图片格式，避免仅靠 URL 或响应头做脆弱判断。
   *
   * @param {Buffer} buffer
   * @param {string} contentType
   * @returns {string}
   * @private
   */
  _detectDownloadedImageFormat(buffer, contentType = '') {
    if (Buffer.isBuffer(buffer) && buffer.length > 0) {
      const detector = IMAGE_SIGNATURE_DETECTORS.find(({ matches }) => matches(buffer));
      if (detector) return detector.format;
    }

    const normalizedType = contentType.toLowerCase();
    return IMAGE_CONTENT_TYPE_FORMATS.find(([type]) => normalizedType.includes(type))?.[1] || '';
  }

  /**
   * 使用项目自带 Python 运行时把图片转换为 PNG。
   *
   * @param {string} inputPath
   * @param {string} outputPath
   * @returns {Promise<void>}
   * @private
   */
  async _convertImageToPng(inputPath, outputPath) {
    await this.processRunner.run(this.config.python?.executable || 'python3', [
      path.join(process.cwd(), 'src/python/convert_image.py'), inputPath, outputPath,
    ], { failureLabel: 'Image conversion failed', timeoutMs: this.config.python?.timeout });
  }

  /**
   * 从 URL 推断文件扩展名；推断失败时保底使用 .img。
   *
   * @param {string} url
   * @returns {string}
   * @private
   */
  _getImageExtensionFromUrl(url, contentType = '', detectedFormat = '') {
    const normalizedFormat = detectedFormat.toLowerCase();
    const normalizedType = contentType.toLowerCase();
    if (normalizedFormat === 'png') return '.png';
    if (normalizedFormat === 'jpg' || normalizedFormat === 'jpeg') return '.jpg';
    if (normalizedFormat === 'webp') return '.webp';
    if (normalizedFormat === 'avif') return '.avif';
    if (normalizedFormat === 'gif') return '.gif';
    if (normalizedFormat === 'svg') return '.svg';
    if (normalizedFormat === 'pdf') return '.pdf';

    if (normalizedType.includes('image/png')) return '.png';
    if (normalizedType.includes('image/jpeg')) return '.jpg';
    if (normalizedType.includes('image/webp')) return '.webp';
    if (normalizedType.includes('image/avif')) return '.avif';
    if (normalizedType.includes('image/gif')) return '.gif';
    if (normalizedType.includes('image/svg+xml')) return '.svg';
    if (normalizedType.includes('application/pdf')) return '.pdf';

    if (!url || typeof url !== 'string') {
      return '.img';
    }

    try {
      const pathname = new URL(url).pathname || '';
      const extension = path.extname(pathname);
      return extension || '.img';
    } catch {
      return '.img';
    }
  }

  /**
   * 创建 Pandoc 头文件，供 --include-in-header 使用。
   *
   * @param {string} tempDir
   * @returns {string}
   * @private
   */
  _createPandocHeaderFile(tempDir) {
    fs.mkdirSync(tempDir, { recursive: true });

    const headerPath = path.join(
      tempDir,
      `pandoc-header-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tex`
    );

    const header = this.layoutAdapter?.composeHeader(pandocHeader) || pandocHeader;
    fs.writeFileSync(headerPath, header, 'utf8');

    return headerPath;
  }

  _buildPandocArgs(inputPath, outputPath, options = {}) {
    const markdownPdfConfig = {
      ...(this.config.markdownPdf || {}),
      ...(options || {}),
    };
    const cjkMainFont = this.layout?.typography.bodyFont
      || markdownPdfConfig.cjkMainFont
      || 'Noto Sans CJK SC';
    const kindleOptions = this.layout ? { pdfOptions: {}, variables: [] }
      : this._getKindlePandocOptions();

    const args = [
      inputPath,
      '-o',
      outputPath,
      '--lua-filter',
      englishAnnotationFilterPath,
      '--pdf-engine=xelatex', // 使用 xelatex 支持中文
      '--variable',
      `CJKmainfont=${cjkMainFont}`, // 主字体（使用 CI 可用的开源字体，支持通过配置覆盖）
    ];

    if (markdownPdfConfig.headerIncludePath) {
      args.push('--include-in-header', markdownPdfConfig.headerIncludePath);
    }

    // 添加其他选项
    const pdfOptions = {
      ...(markdownPdfConfig.pdfOptions || {}),
      ...(kindleOptions.pdfOptions || {}),
    };

    if (this.layoutAdapter) {
      args.push('--variable', this.layoutAdapter.getGeometryVariable());
    } else {
      // 如果指定了格式，添加纸张大小
      if (pdfOptions.format) {
        args.push('--variable', `papersize=${pdfOptions.format.toLowerCase()}`);
      }

      // 如果指定了边距
      args.push('--variable', this._formatPandocMargin(pdfOptions.margin));
    }

    const variables = this.layoutAdapter?.getPandocVariables() || kindleOptions.variables;
    variables.forEach((variable) => {
      args.push('--variable', variable);
    });

    // 添加 TOC（目录）
    if (markdownPdfConfig.toc !== false) {
      args.push('--toc');
      const tocDepth = markdownPdfConfig.tocDepth || 3;
      args.push(`--toc-depth=${tocDepth}`);
    }

    // 语法高亮（Pandoc 3+ 使用 --highlight-style）
    // 支持的样式: pygments, tango, espresso, zenburn, kate, monochrome, breezedark, haddock
    const highlightStyle = markdownPdfConfig.highlightStyle;
    if (highlightStyle) {
      const style = highlightStyle === 'github' ? 'pygments' : highlightStyle;
      args.push('--highlight-style', style);
    }

    return args;
  }

  _getKindlePandocOptions() {
    const pdfConfig = this.config.pdf || {};
    if (!pdfConfig.kindleOptimized) {
      return { pdfOptions: {}, variables: [] };
    }

    const fontSizePx = Number.parseFloat(pdfConfig.fontSize);
    const lineHeight = Number.parseFloat(pdfConfig.lineHeight);
    const variables = ['documentclass=scrartcl'];

    if (Number.isFinite(fontSizePx)) {
      // KOMA-Script accepts arbitrary sizes through its fontsize key. Passing
      // a bare `13.5pt` class option is ignored by XeLaTeX.
      variables.push(`classoption=fontsize=${this._formatDecimal(fontSizePx * 0.75)}pt`);
    }
    if (Number.isFinite(lineHeight)) {
      variables.push(`linestretch=${this._formatDecimal(lineHeight / 1.2)}`);
    }

    return {
      pdfOptions: {
        format: pdfConfig.pageFormat || pdfConfig.format,
        margin: pdfConfig.margin,
      },
      variables,
    };
  }

  _formatDecimal(value) {
    return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }

  _formatPandocMargin(margin) {
    if (!margin) return 'geometry:margin=1in';
    if (typeof margin === 'string') return `geometry:margin=${margin}`;

    const sides = ['top', 'right', 'bottom', 'left'];
    const geometry = sides
      .filter((side) => margin[side])
      .map((side) => `${side}=${margin[side]}`)
      .join(',');
    return geometry ? `geometry:${geometry}` : 'geometry:margin=1in';
  }

  /**
   * 构建 Pandoc -> LaTeX 的命令行参数。
   *
   * @param {string} inputPath
   * @param {string} outputPath
   * @param {Object} options
   * @returns {string[]}
   * @private
   */
  _buildPandocLatexArgs(inputPath, outputPath, options = {}) {
    const args = this._buildPandocArgs(inputPath, outputPath, options).filter(
      (arg) => arg !== '--pdf-engine=xelatex'
    );

    args.push('--standalone', '--to=latex');

    return args;
  }

  /**
   * Generate a single PDF from all markdown files in a directory (batch mode)
   * This bypasses individual PDF generation and creates the final PDF directly
   *
   * @param {string} markdownDir - Directory containing markdown files
   * @param {string} outputPath - Path for the output PDF
   * @param {Object} options - PDF generation options
   * @returns {Promise<{success: boolean, filesProcessed: number, outputPath: string}>}
   */
  async generateBatchPdf(markdownDir, outputPath, options = {}) {
    try {
      this.logger?.info?.('Starting batch PDF generation', {
        markdownDir,
        outputPath,
        layout: this.layout ? {
          id: this.layout.id,
          version: this.layout.version,
          fingerprint: this.layout.fingerprint,
        } : null,
      });

      // 1. Get all markdown files sorted by index
      const artifacts = options.artifacts;
      if (artifacts && (new Set(artifacts.map((a) => a.index)).size !== artifacts.length
        || new Set(artifacts.map((a) => a.url)).size !== artifacts.length)) {
        throw new Error('Duplicate artifact index or URL');
      }
      const files = artifacts ? artifacts.map((artifact) => {
        const relative = path.relative(path.resolve(markdownDir), path.resolve(artifact.path));
        if (!isPathInside(markdownDir, artifact.path) || !relative.endsWith('.md')) {
          throw new Error(`Unsafe Markdown artifact path: ${artifact.path}`);
        }
        return relative;
      }) : this._getMarkdownFiles(markdownDir);
      if (files.length === 0) {
        throw new Error(`No markdown files found in ${markdownDir}`);
      }

      this.logger?.info?.(`Found ${files.length} markdown files for batch processing`);

      // 2. Load section structure and article titles for hierarchical TOC
      let sectionStructure = null;
      let articleTitles = {};

      if (this.metadataService) {
        sectionStructure = await this.metadataService.getSectionStructure();
        articleTitles = await this.metadataService.getArticleTitles();
      }

      // 3. Concatenate markdown files with page breaks
      const combinedContent = this._concatenateMarkdownFiles(
        markdownDir,
        files,
        sectionStructure,
        articleTitles,
        artifacts
      );

      this.logger?.info?.('Markdown files concatenated', {
        totalLength: combinedContent.length,
        filesProcessed: files.length,
      });

      await this._renderContent(combinedContent, outputPath, {
        ...options, toc: options.toc ?? this.config.markdownPdf?.toc ?? true,
        tocDepth: options.tocDepth ?? this.config.markdownPdf?.tocDepth ?? 3,
      });
      this.logger?.info?.('HTTP resource metrics', { ...this.httpResourceService.metrics });
      return { success: true, filesProcessed: files.length, outputPath };

    } catch (error) {
      this.logger?.error?.('Batch PDF generation failed', {
        markdownDir,
        outputPath,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get markdown files from directory, sorted by numeric index
   * @param {string} dir - Directory path
   * @returns {string[]} - Sorted array of filenames
   * @private
   */
  _getMarkdownFiles(dir) {
    if (!fs.existsSync(dir)) {
      return [];
    }

    const originals = fs.readdirSync(dir)
      .filter((file) => file.endsWith('.md')
        && !file.endsWith('_translated.md')
        && !file.endsWith('_annotated.md'));
    const files = originals.map((file) => {
      let suffix = null;
      if (this.config.translation?.enabled) suffix = '_translated.md';
      if (this.config.annotations?.enabled) suffix = '_annotated.md';
      if (!suffix) return file;

      const derived = file.slice(0, -3) + suffix;
      if (!fs.existsSync(path.join(dir, derived))) {
        const label = this.config.annotations?.enabled ? 'annotated' : 'translated';
        throw new Error(`Missing ${label} Markdown: ${derived}`);
      }
      return derived;
    });

    // Sort by numeric prefix (e.g., 000-page.md, 001-page.md)
    return files.sort((a, b) => {
      const aPrefix = a.split('-')[0];
      const bPrefix = b.split('-')[0];

      const aNum = parseInt(aPrefix, 10);
      const bNum = parseInt(bPrefix, 10);

      if (!isNaN(aNum) && !isNaN(bNum)) {
        return aNum - bNum;
      }

      return a.localeCompare(b);
    });
  }

  /**
   * Concatenate markdown files with section headers and page breaks
   * @param {string} dir - Directory path
   * @param {string[]} files - Sorted array of filenames
   * @param {Object|null} sectionStructure - Section structure from metadata
   * @param {Object} articleTitles - Article titles mapping
   * @returns {string} - Combined markdown content
   * @private
   */
  _concatenateMarkdownFiles(dir, files, sectionStructure, articleTitles, artifacts) {
    const sections = sectionStructure?.sections || [];
    // urlToSection is available for future use if needed

    // Build index to file mapping
    const indexToFile = new Map();
    for (const [position, file] of files.entries()) {
      if (artifacts) {
        indexToFile.set(artifacts[position].index, file);
        continue;
      }
      const prefix = file.split('-')[0];
      if (/^\d+$/.test(prefix)) {
        indexToFile.set(String(parseInt(prefix, 10)), file);
      }
    }

    // If we have section structure, organize by sections
    if (sections.length > 0) {
      return this._concatenateWithSections(dir, files, sections, articleTitles, indexToFile, artifacts);
    }

    if (artifacts) throw new Error('Missing section metadata for current-run artifacts');

    // Standalone Markdown directories may intentionally omit section metadata.
    return this._concatenateFlat(dir, files, articleTitles);
  }

  /**
   * Concatenate with section headers for hierarchical TOC
   * @private
   */
  _concatenateWithSections(dir, files, sections, articleTitles, indexToFile, artifacts) {
    const parts = [];
    const processedIndices = new Set();

    for (const section of sections) {
      const sectionTitle = section.title;
      if (!sectionTitle) throw new Error('Missing section title');
      const sectionPages = section.pages || [];

      if (sectionPages.length === 0) continue;

      // Keep the section heading with its first article. A page break before
      // every article used to leave a nearly blank section-title page.
      if (parts.length > 0) parts.push('\\newpage\n');
      parts.push(`# ${sectionTitle}\n`);
      let addedPageCount = 0;

      for (const pageInfo of sectionPages) {
        const pageIndex = pageInfo.index;
        if (typeof pageIndex !== 'string' || processedIndices.has(pageIndex)) {
          throw new Error(`Invalid or duplicate section article index: ${pageIndex}`);
        }
        const file = indexToFile.get(pageIndex);
        if (!file) throw new Error(`Missing Markdown for section article: ${pageIndex}`);

        const filePath = path.join(dir, file);

        const bytes = fs.readFileSync(filePath);
        const artifact = artifacts?.find((item) => item.index === pageIndex);
        if (artifact) {
          if (artifact.url !== pageInfo.url) throw new Error(`Artifact URL mismatch: ${pageIndex}`);
          if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
            throw new Error(`Artifact checksum mismatch: ${artifact.url}`);
          }
        }
        let content = bytes.toString('utf8');

        // Remove frontmatter if present
        content = this.normalizer._removeFrontmatter(content);

        // Get article title
        const title = articleTitles[pageIndex];
        if (!title) throw new Error(`Missing article title: ${pageIndex}`);

        // Strip leading title from content if it duplicates the injected title
        const cleanedContent = this.normalizer._prepareArticleContentForBatch(content, title, pageInfo.url);

        const pageBreak = addedPageCount > 0 ? '\\newpage\n\n' : '';
        parts.push(`${pageBreak}## ${title}\n\n${cleanedContent}\n`);

        processedIndices.add(pageIndex);
        addedPageCount += 1;
      }
    }

    if (processedIndices.size !== files.length) {
      throw new Error('Section metadata does not cover every Markdown article');
    }

    return parts.join('\n');
  }

  /**
   * Flat concatenation without section structure
   * @private
   */
  _concatenateFlat(dir, files, articleTitles) {
    const parts = [];

    for (const file of files) {
      const filePath = path.join(dir, file);
      let content = fs.readFileSync(filePath, 'utf8');
      content = this.normalizer._removeFrontmatter(content);

      // Extract index from filename
      const prefix = file.split('-')[0];
      const index = /^\d+$/.test(prefix) ? String(parseInt(prefix, 10)) : null;

      const title = Object.keys(articleTitles).length
        ? articleTitles[index] : this.normalizer._extractTitleFromContent(content);
      if (!title) throw new Error(`Missing article title: ${file}`);
      const cleanedContent = this.normalizer._prepareArticleContentForBatch(content, title);

      // Add with page break (first page doesn't need break)
      if (parts.length > 0) {
        parts.push(`\\newpage\n\n## ${title}\n\n${cleanedContent}\n`);
      } else {
        parts.push(`## ${title}\n\n${cleanedContent}\n`);
      }
    }

    return parts.join('\n');
  }

  async dispose() {
    await this.processRunner.dispose();
  }
}
