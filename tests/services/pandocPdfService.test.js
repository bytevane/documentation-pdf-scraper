import { describe, it, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';

// tests/services/pandocPdfService.test.js
import { PandocPdfService } from '../../src/services/pandocPdfService.js';
import {
  englishAnnotationFilterPath,
  pandocHeader,
} from '../../src/services/pdf/pandocTemplate.js';
import fs from 'fs';
import path from 'path';


describe('PandocPdfService', () => {
  let service;
  let mockLogger;
  let tempDir;

  beforeEach(() => {
    tempDir = path.join(process.cwd(), '.temp', 'test_pandoc');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    service = new PandocPdfService({
      logger: mockLogger,
      processRunner: { run: vi.fn(), dispose: vi.fn() },
      config: {
        markdownPdf: {
          highlightStyle: 'github',
          pdfOptions: {
            format: 'A4',
            margin: '20mm',
          },
        },
      },
    });
  });

  afterEach(() => {
    // 清理临时文件
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      expect(service.pandocBinary).toBe('pandoc');
      expect(service.config).toBeDefined();
      expect(service.logger).toBe(mockLogger);
    });

    it('should accept custom pandoc binary path', () => {
      const customService = new PandocPdfService({
        pandocBinary: '/custom/path/pandoc',
      });
      expect(customService.pandocBinary).toBe('/custom/path/pandoc');
    });
  });

  it('fails on malformed MDX and never retries with regex stripping', async () => {
    service.normalizer.config.markdownSource = { format: 'mdx' };
    await expect(service.convertContentToPdf('# Guide\n\n<Tabs><Tab>unfinished', 'unused.pdf'))
      .rejects.toThrow('MDX');
    expect(service.processRunner.run).not.toHaveBeenCalled();
  });

  it('honors toc=false for batch rendering', async () => {
    fs.writeFileSync(path.join(tempDir, '000-guide.md'), '# Guide\n\nBody.');
    const render = vi.spyOn(service, '_renderContent').mockResolvedValue();
    await service.generateBatchPdf(tempDir, 'unused.pdf', { toc: false });
    expect(render.mock.calls[0][2].toc).toBe(false);
  });

  it('preserves nested lists, indented code and literal tables inside fences', () => {
    const markdown = '- Parent\n  - Child\n\n    console.log("indented code")\n\n```markdown\n| A | B |\n| --- | --- |\n| x | y |\n```\n';
    expect(service.normalizer._cleanMarkdownContent(markdown)).toBe(markdown);
  });

  it('does not strip leading code indentation while removing article metadata and titles', () => {
    const content = service.normalizer._removeFrontmatter('---\ntitle: Guide\n---\n\n# Guide\n\n    code()');
    expect(service.normalizer._prepareArticleContentForBatch(content, 'Guide')).toBe('    code()');
  });

  it('allows escaped prose filenames to wrap while preserving code spelling', () => {
    const result = service.normalizer._cleanMarkdownContent('Use claude\\_desktop\\_config.json. Code: `a\\_b`.');
    expect(result).toContain('claude\\_\\allowbreak{}desktop\\_\\allowbreak{}config.json');
    expect(result).toContain('`a\\_b`');
  });

  it('retains MDX card titles, destinations and static expressions', () => {
    service.normalizer.config.markdownSource = { format: 'mdx' };
    const markdown = '<Card title="Quickstart" href="/docs/start">Read this guide.</Card>\n\n<Card title="Reference" href="/docs/reference" />\n\nThe default limit is {1000}, and <span class="english-annotation-source">under the hood</span> remains traceable.';
    const result = service.normalizer._cleanMarkdownContent(markdown);
    expect(result).toContain('[Quickstart](/docs/start)');
    expect(result).toContain('Read this guide.');
    expect(result).toContain('[Reference](/docs/reference)');
    expect(result).toContain('The default limit is 1000, and');
    expect(result).toContain(
      '<span class="english-annotation-source">under the hood</span>'
    );
    expect(service.normalizer._prepareArticleContentForBatch(markdown, 'Guide', 'https://example.com/other/page'))
      .toContain('[Quickstart](https://example.com/docs/start)');
  });

  it('rejects metadata read errors before rendering a flattened book', async () => {
    fs.writeFileSync(path.join(tempDir, '000-guide.md'), '# Guide');
    service.metadataService = { getSectionStructure: vi.fn().mockRejectedValue(new Error('bad metadata')) };
    await expect(service.generateBatchPdf(tempDir, 'unused.pdf')).rejects.toThrow('bad metadata');
    expect(service.processRunner.run).not.toHaveBeenCalled();
  });

  it('selects translated artifacts only when enabled and requires all of them', () => {
    fs.writeFileSync(path.join(tempDir, '000-guide.md'), '# Guide');
    fs.writeFileSync(path.join(tempDir, '000-guide_translated.md'), '# Translated guide');
    fs.writeFileSync(path.join(tempDir, '001-reference.md'), '# Reference');
    expect(service._getMarkdownFiles(tempDir)).toEqual(['000-guide.md', '001-reference.md']);
    service.config.translation = { enabled: true };
    expect(() => service._getMarkdownFiles(tempDir)).toThrow('Missing translated Markdown: 001-reference_translated.md');
  });

  it('ignores stale derived files and selects annotated artifacts only when enabled', () => {
    fs.writeFileSync(path.join(tempDir, '000-guide.md'), '# Guide');
    fs.writeFileSync(path.join(tempDir, '000-guide_annotated.md'), '# Annotated guide');
    fs.writeFileSync(path.join(tempDir, '000-guide_translated.md'), '# Translated guide');
    fs.writeFileSync(path.join(tempDir, '001-reference.md'), '# Reference');

    expect(service._getMarkdownFiles(tempDir)).toEqual(['000-guide.md', '001-reference.md']);
    service.config.annotations = { enabled: true };
    expect(() => service._getMarkdownFiles(tempDir)).toThrow(
      'Missing annotated Markdown: 001-reference_annotated.md'
    );
    fs.writeFileSync(path.join(tempDir, '001-reference_annotated.md'), '# Annotated reference');
    expect(service._getMarkdownFiles(tempDir)).toEqual([
      '000-guide_annotated.md',
      '001-reference_annotated.md',
    ]);
  });

  describe('_buildPandocArgs', () => {
    it('should build basic args', () => {
      const args = service._buildPandocArgs('input.md', 'output.pdf', {});
      expect(args).toContain('input.md');
      expect(args).toContain('-o');
      expect(args).toContain('output.pdf');
      expect(args).toContain('--pdf-engine=xelatex');
      expect(args).toContain('--lua-filter');
      expect(args).toContain(englishAnnotationFilterPath);
    });

    it('should include format option', () => {
      const args = service._buildPandocArgs('input.md', 'output.pdf', {
        pdfOptions: { format: 'A4' },
      });
      expect(args).toContain('--variable');
      expect(args).toContain('papersize=a4');
    });

    it('should include margin option', () => {
      const args = service._buildPandocArgs('input.md', 'output.pdf', {
        pdfOptions: { margin: '1in' },
      });
      expect(args).toContain('--variable');
      expect(args).toContain('geometry:margin=1in');
    });

    it('should include TOC by default', () => {
      const args = service._buildPandocArgs('input.md', 'output.pdf', {});
      expect(args).toContain('--toc');
      expect(args).toContain('--toc-depth=3');
    });

    it('should exclude TOC when disabled', () => {
      const args = service._buildPandocArgs('input.md', 'output.pdf', {
        toc: false,
      });
      expect(args).not.toContain('--toc');
    });

    it('should include highlight style', () => {
      const args = service._buildPandocArgs('input.md', 'output.pdf', {
        highlightStyle: 'tango',
      });
      expect(args).toContain('--highlight-style');
      expect(args).toContain('tango');
    });

    it('should convert github style to pygments', () => {
      const args = service._buildPandocArgs('input.md', 'output.pdf', {
        highlightStyle: 'github',
      });
      expect(args).toContain('--highlight-style');
      expect(args).toContain('pygments');
      expect(args).not.toContain('github');
    });

    it('should default to a CI-safe open-source CJK font', () => {
      const args = service._buildPandocArgs('input.md', 'output.pdf', {});

      expect(args).toContain('CJKmainfont=Noto Sans CJK SC');
      expect(args).not.toContain('CJKmainfont=Arial Unicode MS');
    });

    it('should include a header file instead of raw header-includes latex', () => {
      const args = service._buildPandocArgs('input.md', 'output.pdf', {
        headerIncludePath: '/tmp/pandoc-header.tex',
      });

      expect(args).toContain('--include-in-header');
      expect(args).toContain('/tmp/pandoc-header.tex');
      expect(args.some((arg) => arg.includes('header-includes='))).toBe(false);
    });

    it('should build latex args without invoking pandoc pdf-engine orchestration', () => {
      const args = service._buildPandocLatexArgs('input.md', 'output.tex', {
        headerIncludePath: '/tmp/pandoc-header.tex',
      });

      expect(args).toContain('--standalone');
      expect(args).toContain('--to=latex');
      expect(args).not.toContain('--pdf-engine=xelatex');
    });

    it('should configure both Highlighting and plain verbatim blocks to wrap long lines', () => {
      const header = pandocHeader;

      expect(header).toContain(
        '\\RecustomVerbatimEnvironment{verbatim}{Verbatim}{breaklines,breakanywhere,fontsize=\\small}'
      );
      expect(header).toContain(
        '\\DefineVerbatimEnvironment{Highlighting}{Verbatim}{breaklines,breakanywhere,fontsize=\\small,commandchars=\\\\\\{\\}}'
      );
    });

    it('should render semantic annotation anchors with a neutral dotted underline', () => {
      expect(pandocHeader).toContain('\\usepackage[normalem]{ulem}');
      expect(pandocHeader).toContain('\\newcommand{\\englishannotationsource}[1]');
      expect(pandocHeader).toContain('line cap=round');
      expect(pandocHeader).toContain('dash pattern=on 0pt off 1.35pt');
      expect(pandocHeader).not.toContain('decoration={snake');
      const filter = fs.readFileSync(englishAnnotationFilterPath, 'utf8');
      expect(filter).toContain("english-annotation-source");
      expect(filter).toContain("english-annotation");
      expect(filter).toContain("english-learning-review");
    });

    it('should give annotations and active-recall reviews distinct breakable layouts', () => {
      expect(pandocHeader).toContain('\\usepackage[most]{tcolorbox}');
      expect(pandocHeader).toContain('\\newtcolorbox{englishannotationbox}');
      expect(pandocHeader).toContain('\\newtcolorbox{englishreviewbox}');
      expect(pandocHeader).toContain('breakable');
      expect(pandocHeader).toContain('fontupper=\\small');
    });

    it('should route every normalized broad American IPA symbol through DejaVu Sans', () => {
      expect(pandocHeader).toContain('\\newfontfamily\\scraperIPA{DejaVu Sans}');
      for (const symbol of [...'æðŋɑɔɒəɛɜɝɡɪɹʃʊʌʒˈˌːθ']) {
        expect(pandocHeader).toContain(`\\newunicodechar{${symbol}}`);
      }
    });

    it('should route the almost-equal sign missing from Latin Modern text fonts', () => {
      expect(pandocHeader).toContain('\\newfontfamily\\scraperMathSymbols{latinmodern-math.otf}');
      expect(pandocHeader).toContain('\\newunicodechar{≈}{{\\scraperMathSymbols ≈}}');
    });

    it('should apply publication-quality TOC typography and spacing', () => {
      const header = pandocHeader;

      expect(header).toContain('\\usepackage{tocloft}');
      expect(header).toContain('\\setlength{\\cftsubsecindent}{1.5em}');
      expect(header).toContain('\\setlength{\\cftsubsubsecindent}{3.0em}');
      expect(header).toContain('\\renewcommand{\\cftdotsep}{1.5}');
      expect(header).toContain('\\renewcommand{\\cftsecfont}{\\large\\bfseries}');
      expect(header).toContain('\\renewcommand{\\cftsubsubsecfont}{\\small}');
      expect(header).toContain('\\pagenumbering{roman}');
      expect(header).toContain('\\clearpage\\pagenumbering{arabic}');
    });

    it('should allow overriding the CJK main font from config', () => {
      const customService = new PandocPdfService({
        logger: mockLogger,
        config: {
          markdownPdf: {
            cjkMainFont: 'Source Han Sans SC',
          },
        },
      });

      const args = customService._buildPandocArgs('input.md', 'output.pdf', {});

      expect(args).toContain('CJKmainfont=Source Han Sans SC');
    });

    it('should apply the Kindle Scribe profile to Pandoc output', () => {
      const scribeService = new PandocPdfService({
        logger: mockLogger,
        config: {
          pdf: {
            kindleOptimized: true,
            deviceProfile: 'scribe',
            fontSize: '18px',
            lineHeight: '1.7',
            pageFormat: 'A4',
            margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' },
          },
          markdownPdf: {
            pdfOptions: { format: 'Letter', margin: '20mm' },
          },
        },
      });

      const args = scribeService._buildPandocArgs('input.md', 'output.pdf');

      expect(args).toContain('papersize=a4');
      expect(args).toContain('documentclass=scrartcl');
      expect(args).toContain('classoption=fontsize=13.5pt');
      expect(args).toContain('linestretch=1.417');
      expect(args).toContain('geometry:top=1cm,right=1cm,bottom=1cm,left=1cm');
      expect(args).not.toContain('papersize=letter');
      expect(args).not.toContain('geometry:margin=20mm');
    });

    it('should let reading-5x8 own geometry and typography instead of inherited A4 fields', () => {
      const readingService = new PandocPdfService({
        logger: mockLogger,
        config: {
          pdf: { layoutPreset: 'reading-5x8' },
          markdownPdf: {
            cjkMainFont: 'Noto Sans CJK SC',
            pdfOptions: { format: 'A4', margin: '20mm' },
          },
        },
      });
      const args = readingService._buildPandocArgs('input.md', 'output.pdf');
      expect(args).toContain('geometry:paperwidth=5in,paperheight=8in,top=0.65in,right=0.5in,bottom=0.65in,left=0.5in,headheight=10pt,headsep=8pt,footskip=24pt');
      expect(args).toContain('CJKmainfont=Noto Serif CJK SC');
      expect(args).toContain('classoption=fontsize=10.5pt');
      expect(args).toContain('linestretch=1.25');
      expect(args).not.toContain('papersize=a4');
      expect(args).not.toContain('geometry:margin=20mm');
      const headerPath = readingService._createPandocHeaderFile(tempDir);
      const header = fs.readFileSync(headerPath, 'utf8');
      expect(header).toContain('Layout Pack: reading-5x8@1.0.0');
      expect(header).toContain('PunctStyle=kaiming');
      expect(header).toContain('scrlayer-scrpage');
    });
  });

  describe('_concatenateMarkdownFiles', () => {
    it.each(['missing title', 'missing file', 'unmapped file'])('rejects incomplete section metadata: %s', (failure) => {
      const files = ['000-guide.md'];
      const titles = failure === 'missing title' ? {} : { 0: 'Guide' };
      fs.writeFileSync(path.join(tempDir, files[0]), '# Guide');
      const pages = [{ index: failure === 'missing file' ? '2' : '0' }];
      if (failure === 'unmapped file') {
        files.push('001-extra.md');
        fs.writeFileSync(path.join(tempDir, files[1]), '# Extra');
      }
      expect(() => service._concatenateMarkdownFiles(tempDir, files,
        { sections: [{ title: 'Section', pages }] }, titles)).toThrow();
    });
    it('keeps a section heading with its first article instead of creating a title-only page', () => {
      fs.writeFileSync(path.join(tempDir, '000-first.md'), '# First\n\nFirst body.');
      fs.writeFileSync(path.join(tempDir, '001-second.md'), '# Second\n\nSecond body.');

      const combined = service._concatenateMarkdownFiles(
        tempDir,
        ['000-first.md', '001-second.md'],
        {
          sections: [
            {
              title: 'Section',
              pages: [{ index: '0' }, { index: '1' }],
            },
          ],
        },
        { 0: 'First', 1: 'Second' }
      );

      expect(combined).toMatch(/^# Section\n\n## First/);
      expect(combined).toContain('\\newpage\n\n## Second');
      expect(combined).not.toContain('# Section\n\n\\newpage');
    });

    it('builds a readable three-level TOC hierarchy from indexed MDX pages', () => {
      service.config.markdownSource = { format: 'mdx' };
      fs.writeFileSync(
        path.join(tempDir, '000-first.md'),
        [
          '---',
          'title: First',
          '---',
          '> ## Documentation Index',
          '> Fetch the complete documentation index at: https://example.com/llms.txt',
          '> Use this file to discover all available pages before exploring further.',
          '',
          '# First',
          '',
          'Intro.',
          '',
          '## Main topic',
          '',
          '### Detail excluded from a depth-three TOC',
          '',
          '```md',
          '# Example heading must stay unchanged',
          '```',
        ].join('\n')
      );

      const combined = service._concatenateMarkdownFiles(
        tempDir,
        ['000-first.md'],
        { sections: [{ title: 'Section', pages: [{ index: '0' }] }] },
        { 0: 'First' }
      );

      expect(combined.match(/^# Section$/gm)).toHaveLength(1);
      expect(combined.match(/^## First$/gm)).toHaveLength(1);
      expect(combined).not.toMatch(/^# First$/m);
      expect(combined).toContain('### Main topic');
      expect(combined).toContain('#### Detail excluded from a depth-three TOC');
      expect(combined).toContain('# Example heading must stay unchanged');
      expect(combined).not.toContain('Documentation Index');
    });

    it('keeps MDX steps below the article main sections in the TOC hierarchy', () => {
      service.config.markdownSource = { format: 'mdx' };
      const content = [
        '# First',
        '',
        '## Workflow',
        '',
        '<Steps>',
        '  <Step title="Explore">',
        '    Read the code.',
        '  </Step>',
        '</Steps>',
      ].join('\n');

      const result = service.normalizer._prepareArticleContentForBatch(content, 'First');

      expect(result).toContain('### Workflow');
      expect(result).toContain('#### Explore');
      expect(result).not.toMatch(/^### Explore$/m);
    });
  });

  describe('convertContentToPdf', () => {
    it('should create temp file and convert content', async () => {
      const content = '# Test\n\nThis is a test.';
      const outputPath = path.join(tempDir, 'output.pdf');

      // Mock _runPandoc
      service._runPandoc = vi.fn().mockResolvedValue();

      await service.convertContentToPdf(content, outputPath);

      expect(service._runPandoc).toHaveBeenCalled();
      expect(fs.existsSync(service._runPandoc.mock.calls[0][0])).toBe(false);
    });

    it('should cleanup temp file after conversion', async () => {
      const content = '# Test';
      const outputPath = path.join(tempDir, 'output.pdf');

      service._runPandoc = vi.fn().mockResolvedValue();

      await service.convertContentToPdf(content, outputPath);

      // 检查临时文件是否被清理
      const tempFiles = fs
        .readdirSync(path.join(process.cwd(), '.temp'))
        .filter((f) => f.startsWith('temp_') && f.endsWith('.md'));

      expect(tempFiles.length).toBe(0);
    });

    it('should handle conversion errors', async () => {
      const content = '# Test';
      const outputPath = path.join(tempDir, 'output.pdf');

      service._runPandoc = vi.fn().mockRejectedValue(new Error('Pandoc error'));

      await expect(service.convertContentToPdf(content, outputPath)).rejects.toThrow(
        'Pandoc error'
      );

      expect(fs.existsSync(service._runPandoc.mock.calls[0][0])).toBe(false);
    });
  });

  describe('convertToPdf', () => {
    it('should convert markdown file to pdf', async () => {
      const inputPath = path.join(tempDir, 'input.md');
      const outputPath = path.join(tempDir, 'output.pdf');

      fs.writeFileSync(inputPath, '# Test\n\nContent', 'utf8');

      service._runPandoc = vi.fn().mockResolvedValue();

      await service.convertToPdf(inputPath, outputPath);

      expect(service._runPandoc).toHaveBeenCalledWith(
        expect.stringContaining('.temp/render-'),
        outputPath,
        expect.any(Object)
      );
      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should handle file conversion errors', async () => {
      const inputPath = path.join(tempDir, 'input.md');
      const outputPath = path.join(tempDir, 'output.pdf');

      fs.writeFileSync(inputPath, '# Test', 'utf8');

      service._runPandoc = vi.fn().mockRejectedValue(new Error('File error'));

      await expect(service.convertToPdf(inputPath, outputPath)).rejects.toThrow('File error');

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('_cleanMarkdownContent', () => {
    it('should remove theme={null} from standard code blocks', () => {
      const input = '```markdown theme={null}\ncontent\n```';
      const expected = '```markdown\ncontent\n```';
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).toBe(expected);
    });

    it('should remove theme={null} from code blocks with 4 backticks', () => {
      const input = '````markdown theme={null}\ncontent\n````';
      const expected = '````markdown\ncontent\n````';
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).toBe(expected);
    });

    it('should normalize fenced code attributes inside list items', () => {
      const input = '* Run:\n\n  ```bash theme={null}\n  echo hello\n  ```';
      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toContain('  ```bash\n  echo hello\n  ```');
      expect(result).not.toContain('theme={null}');
    });

    it('should remove generic props from code blocks with 4 backticks', () => {
      const input = '````javascript filename="test.js"\ncontent\n````';
      const expected = '````javascript\ncontent\n````';
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).toBe(expected);
    });

    it('should convert Info component with list items to fully-quoted blockquote', () => {
      service.config.markdownSource = { format: 'mdx' };
      const input = '<Info>\n- Step 1\n- Step 2\n</Info>';
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).toContain('> **Note:**\n>\n> \\nopagebreak[4]\n>\n> - Step 1');
      expect(result).toContain('> - Step 2');
      // No unquoted list items
      expect(result).not.toMatch(/^- Step/m);
    });

    it('should convert Tip component with multiline content to blockquote', () => {
      service.config.markdownSource = { format: 'mdx' };
      const input = '<Tip>\nDo this first.\n- Option A\n- Option B\n</Tip>';
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).toContain('> **Tip:**\n>\n> \\nopagebreak[4]\n>\n> Do this first.');
      expect(result).toContain('> - Option A');
      expect(result).toContain('> - Option B');
    });

    it('should preserve paragraph and fenced-code boundaries inside Tip components', () => {
      service.config.markdownSource = { format: 'mdx' };
      const input = [
        '<Tip>',
        '  Use `jq` to extract the result:',
        '',
        '  ```bash theme={null}',
        "  claude -p 'Summarize' --output-format json | jq -r '.result'",
        '  ```',
        '</Tip>',
      ].join('\n');

      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toContain('> **Tip:**');
      expect(result).toContain('>\n> Use `jq` to extract the result:');
      expect(result).toContain('>\n> ```bash');
      expect(result).toContain("claude -p 'Summarize'");
      expect(result).not.toContain('theme={null}');
    });

    it('should preserve code indentation while removing MDX wrapper indentation', () => {
      service.config.markdownSource = { format: 'mdx' };
      const input = [
        '<Tip>',
        '  Example:',
        '',
        '  ```python theme={null}',
        '  def greet():',
        '      return "hello"',
        '  ```',
        '</Tip>',
        '',
        '```python',
        'def other():',
        '    return True',
        '```',
      ].join('\n');

      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toContain('> def greet():\n>     return "hello"');
      expect(result).toContain('def other():\n    return True');
    });

    it('should disable syntax highlighting only for fenced blocks with unsafe long lines', () => {
      const longSchema = JSON.stringify({
        type: 'object',
        properties: { functions: { type: 'array', items: { type: 'string' } } },
        required: ['functions'],
      });
      const input = [
        '```bash',
        `claude -p "Extract functions" --json-schema '${longSchema}'`,
        '```',
        '',
        '```bash',
        'echo short',
        '```',
      ].join('\n');

      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toMatch(/^```\nclaude -p/m);
      expect(result).toContain('```bash\necho short\n```');
    });

    it('should linearize wide field reference tables for professional A4 layout', () => {
      const input = [
        '| Field | Required | Description |',
        '| :--- | :--- | :--- |',
        '| `name` | No | Display name shown in skill listings. |',
        '| `shell` | No | Shell for `` !`command` `` and ` ```! ` blocks. |',
      ].join('\n');

      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).not.toContain('| Field | Required | Description |');
      expect(result).toContain('**Field:** `name`');
      expect(result).toContain('**Required:** No');
      expect(result).toContain('\\hfill{} **Required:** No');
      expect(result).toContain('\\nopagebreak[4]\n\nDisplay name shown in skill listings.');
      expect(result).toContain('Display name shown in skill listings.');
      expect(result).toContain('Shell for `` !`command` `` and ` ```! ` blocks.');
      expect(result).not.toContain('\\allowbreak{}');
    });

    it('should keep callout labels with their content without changing code examples', () => {
      service.config.markdownSource = { format: 'mdx' };
      const example = '```md\n> **Note:**\n>\n> Example note.\n```';
      const input = '<Note>\nRead this before continuing.\n</Note>\n\n' + example;

      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toContain('> **Note:**\n>\n> \\nopagebreak[4]\n>\n> Read this before continuing.');
      expect(result).not.toContain('\\Needspace');
      expect(result).toContain(example);
    });

    it('should match complete backtick runs without swallowing surrounding prose', () => {
      const input = 'Shell for `` !`command` `` and ` ```! ` blocks. Accepts `bash` or `powershell`. See [PowerShell tool](https://example.com/tools-reference#powershell-tool).';

      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toBe(input);
      expect(result).not.toContain('\\texttt{');
    });

    it('should leave field reference table examples inside code fences unchanged', () => {
      const input = [
        '```md',
        '| Field | Required | Description |',
        '| --- | --- | --- |',
        '| `name` | No | Display name. |',
        '```',
      ].join('\n');

      expect(service.normalizer._formatFieldReferenceTablesForPdf(input)).toBe(input);
    });

    it('should keep only the visible light-theme SVG from a theme pair', () => {
      service.config.markdownSource = { format: 'mdx' };
      const input = [
        '<img src="https://example.com/loop.svg" className="dark:hidden" alt="Loop" />',
        '',
        '<img src="https://example.com/loop-dark.svg" className="hidden dark:block" alt="Loop" />',
      ].join('\n');

      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toContain('https://example.com/loop.svg');
      expect(result).not.toContain('https://example.com/loop-dark.svg');
    });

    it('should convert Warning component to blockquote', () => {
      service.config.markdownSource = { format: 'mdx' };
      const input = '<Warning>\nDanger ahead!\n</Warning>';
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).toContain('> **Warning:**\n>\n> \\nopagebreak[4]\n>\n> Danger ahead!');
    });

    it('should remove empty list items inside blockquotes', () => {
      const input = '> -\n> text after';
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).not.toMatch(/^>\s*-\s*$/m);
    });

    it('should insert blank line between blockquote prose and list', () => {
      const input = '> Some text\n> - item 1';
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).toBe('> Some text\n>\n> - item 1');
    });

    it('should preserve reference tables with PDF-friendly column widths', () => {
      const input = [
        'Before.',
        '',
        '| Key | Type / Values | Details |',
        '| --- | --- | --- |',
        '| `approval_policy.granular.request_permissions` | `boolean` | When `true`, prompts from the `request_permissions` tool are allowed to surface. |',
        '| `approval_policy` | `untrusted \\| on-request \\| never` | Controls when Codex pauses for approval. |',
        '',
        'After.',
      ].join('\n');

      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toContain('| Key | Type / Values | Details |');
      expect(result).toContain(
        '|:------------------------------------|:----------------------------|:----------------------------------------------------|'
      );
      expect(result).toContain(
        '\\texttt{approval\\_\\allowbreak{}policy.\\allowbreak{}granular.\\allowbreak{}request\\_\\allowbreak{}permissions}'
      );
      expect(result).toContain('`boolean`');
      expect(result).toContain(
        '\\texttt{untrusted |\\allowbreak{} on-\\allowbreak{}request |\\allowbreak{} never}'
      );
      expect(result).toContain('After.');
    });

    it('should preserve metric catalog tables with PDF-friendly column widths', () => {
      const input = [
        '| Metric | Type | Fields | Description |',
        '| --- | --- | --- | --- |',
        '| `websocket.request.duration_ms` | histogram | `success` | WebSocket request duration in milliseconds. |',
        '| `responses_api_engine_service_tbt.duration_ms` | histogram |   | Responses API engine service time-between-token timing. |',
      ].join('\n');

      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toContain('| Metric | Type | Fields | Description |');
      expect(result).toContain(
        '|:------------------------------------------|:--------------|:------------------------------|:------------------------------------------------|'
      );
      expect(result).toContain(
        '\\texttt{websocket.\\allowbreak{}request.\\allowbreak{}duration\\_\\allowbreak{}ms}'
      );
      expect(result).toContain(
        '\\texttt{responses\\_\\allowbreak{}api\\_\\allowbreak{}engine\\_\\allowbreak{}service\\_\\allowbreak{}tbt.\\allowbreak{}duration\\_\\allowbreak{}ms}'
      );
    });

    it('should add break opportunities to long camelCase inline configuration keys', () => {
      const result = service.normalizer._cleanMarkdownContent(
        'Require approval with `isolatePeerMachines` before sending.'
      );

      expect(result).toContain(
        '\\texttt{isolate\\allowbreak{}Peer\\allowbreak{}Machines}'
      );
    });

    it('should preserve sandbox approval tables with PDF-friendly column widths', () => {
      const input = [
        '| Intent | Flags | Effect |',
        '| --- | --- | --- |',
        '| Automatically edit but ask for approval to run untrusted commands | `--sandbox workspace-write --ask-for-approval untrusted` | Codex can read and edit files but asks for approval before running untrusted commands. |',
        '| Dangerous full access | `--dangerously-bypass-approvals-and-sandbox` (alias: `--yolo`) | [Elevated Risk](https://help.openai.com/articles/20001061)No sandbox; no approvals *(not recommended)* |',
      ].join('\n');

      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toContain('| Intent | Flags | Effect |');
      expect(result).toContain(
        '|:--------------------------------|:----------------------------------------------|:----------------------------------------------------|'
      );
      expect(result).toContain(
        '\\texttt{-\\allowbreak{}-\\allowbreak{}dangerously-\\allowbreak{}bypass-\\allowbreak{}approvals-\\allowbreak{}and-\\allowbreak{}sandbox} (alias: `--yolo`)'
      );
      expect(result).toContain('[Elevated Risk](https://help.openai.com/articles/20001061) No sandbox');
    });

    it('should remove duplicate reference card blocks after a reference table', () => {
      const input = [
        '| Key | Type / Values | Details |',
        '| --- | --- | --- |',
        '| `approval_policy.granular.request_permissions` | `boolean` | Table details. |',
        '',
        'Key',
        '',
        '`approval_policy.granular.request_permissions`',
        '',
        'Type / Values',
        '',
        '`boolean`',
        '',
        'Details',
        '',
        'Duplicate card details.',
        '',
        'After.',
      ].join('\n');

      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toContain('| Key | Type / Values | Details |');
      expect(result).toContain('Table details.');
      expect(result).not.toContain('Duplicate card details.');
      expect(result).toContain('After.');
    });

    it('should normalize card-only reference blocks when no table was present', () => {
      const input = [
        'Key',
        '',
        '`standalone.key`',
        '',
        'Type / Values',
        '',
        '`string`',
        '',
        'Details',
        '',
        'Only card details.',
      ].join('\n');

      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toContain('**Key:** \\texttt{standalone.\\allowbreak{}key}');
      expect(result).toContain('**Type / Values:** string');
      expect(result).toContain('**Details:** Only card details.');
    });

    it('should convert long inline paths to breakable LaTeX paths', () => {
      const input =
        'Use `$REPO_ROOT/.agents/plugins/marketplace.json` for a repo-scoped list and keep `plugins[]` unchanged.';

      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toContain(
        '\\texttt{\\$REPO\\_\\allowbreak{}ROOT/\\allowbreak{}.\\allowbreak{}agents/\\allowbreak{}plugins/\\allowbreak{}marketplace.\\allowbreak{}json}'
      );
      expect(result).toContain('`plugins[]`');
    });

    it('should not pair closing inline-code ticks with later inline-code openings', () => {
      const input =
        'Use `$REPO_ROOT/.agents/plugins/marketplace.json`, then add a `./`\\-prefixed path relative to the marketplace root and set `interface.displayName`.';

      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toContain(
        '\\texttt{\\$REPO\\_\\allowbreak{}ROOT/\\allowbreak{}.\\allowbreak{}agents/\\allowbreak{}plugins/\\allowbreak{}marketplace.\\allowbreak{}json}'
      );
      expect(result).toContain('`./`\\-prefixed path relative to the marketplace root');
      expect(result).toContain('\\texttt{interface.\\allowbreak{}display\\allowbreak{}Name}');
      expect(result).not.toContain('\\texttt{\\-\\allowbreak{}prefixed');
    });

    it('should strip multi-line MDX export const declarations', () => {
      service.config.markdownSource = { format: 'mdx' };
      const input = [
        '# Quickstart',
        '',
        'export const InstallConfigurator = () => {',
        "  const TERM = { mac: 'curl -fsSL https://claude.ai/install.sh | bash' };",
        '  return <div>stuff</div>;',
        '};',
        '',
        '## Step 1',
        'Real content.',
      ].join('\n');
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).not.toContain('export const InstallConfigurator');
      expect(result).not.toContain('const TERM');
      expect(result).toContain('# Quickstart');
      expect(result).toContain('## Step 1');
      expect(result).toContain('Real content.');
    });

    it('should strip MDX export that uses template literals with backticks', () => {
      service.config.markdownSource = { format: 'mdx' };
      // Reproduces the quickstart.md Experiment helper shape that triggered
      // the CI LaTeX error: backtick template literals confused pandoc into
      // opening math mode inside escaped prose.
      const input = [
        'prefix text',
        '',
        'export const Experiment = ({flag, treatment, children}) => {',
        '  const ajsMatch = document.cookie.match(/(?:^|; )ajs=([^;]+)/);',
        '  const vid = decodeURIComponent(ajsMatch[1]).replace(/^"|"$/g, "");',
        '  document.cookie = `ajs=${vid}; domain=.claude.com`;',
        '  return treatment;',
        '};',
        '',
        'suffix text',
      ].join('\n');
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).not.toContain('export const Experiment');
      expect(result).not.toContain('document.cookie');
      expect(result).toContain('prefix text');
      expect(result).toContain('suffix text');
    });

    it('rejects unsupported dynamic components rather than silently deleting content', () => {
      service.config.markdownSource = { format: 'mdx' };
      expect(() => service.normalizer._cleanMarkdownContent(
        '<Experiment flag="quickstart-install-configurator" treatment={<InstallConfigurator />} />'
      )).toThrow('Unsupported empty MDX component <Experiment>');
      expect(() => service.normalizer._cleanMarkdownContent('Limit: {config.limit}'))
        .toThrow('Unsupported dynamic MDX expression');
    });

    it('should strip JSX tag with multiple nested JSX attribute values', () => {
      service.config.markdownSource = { format: 'mdx' };
      const input =
        '<Card icon={<Icon name="book" />} action={<Button label="Go" />}>Content</Card>';
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).not.toContain('<Card');
      expect(result).not.toContain('</Card');
      expect(result).not.toContain('<Icon');
      expect(result).not.toContain('<Button');
      expect(result).toContain('Content');
    });

    it('should strip MDX export containing embedded CSS template literal', () => {
      service.config.markdownSource = { format: 'mdx' };
      // Regression: CSS inside a JS template literal has bare `}` at column 0
      // (end of each CSS rule). Earlier regex stopped at the first such `}`
      // and left the rest of the CSS leaking into the PDF. The real closer is
      // always `};` with a semicolon.
      const input = [
        '# Quickstart',
        '',
        'export const InstallConfigurator = () => {',
        '  const STYLES = `',
        '.cc-ic {',
        '  --ic-slate: #141413;',
        '  font-size: 14px;',
        '}',
        '.dark .cc-ic {',
        '  --ic-slate: #f0eee6;',
        '}',
        '.cc-ic-tab-strip {',
        '  display: inline-flex;',
        '}',
        '`;',
        '  return <div className="cc-ic">hi</div>;',
        '};',
        '',
        '## Step 1',
        'Body.',
      ].join('\n');
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).not.toContain('cc-ic');
      expect(result).not.toContain('--ic-slate');
      expect(result).not.toContain('inline-flex');
      expect(result).not.toContain('export const InstallConfigurator');
      expect(result).toContain('# Quickstart');
      expect(result).toContain('## Step 1');
      expect(result).toContain('Body.');
    });

    it('should strip multiple consecutive MDX export blocks', () => {
      service.config.markdownSource = { format: 'mdx' };
      const input = [
        'export const A = () => {',
        '  return 1;',
        '};',
        '',
        'export const B = () => {',
        '  return 2;',
        '};',
        '',
        '# Real title',
      ].join('\n');
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).not.toContain('export const A');
      expect(result).not.toContain('export const B');
      expect(result).toContain('# Real title');
    });

    it('should preserve and constrain webp markdown images for the conversion stage', () => {
      const input = '![App screenshot](https://developers.openai.com/images/app.webp)';
      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toBe('![App screenshot](https://developers.openai.com/images/app.webp){width=100%}');
    });

    it('preserves image URL parameters and literal code for byte-based image conversion', () => {
      const input =
        '![Chart](https://cdn.example.com/chart.webp?fm=webp&fit=max)';
      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toBe('![Chart](https://cdn.example.com/chart.webp?fm=webp&fit=max){width=100%}');
      expect(service.normalizer._cleanMarkdownContent('`format=fm=webp`')).toBe('`format=fm=webp`');
    });

    it('should preserve raw html img tags that point to webp assets for conversion', () => {
      const input =
        '<img src="https://developers.openai.com/images/app.webp" alt="App screenshot">';
      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toBe('<img src="https://developers.openai.com/images/app.webp" alt="App screenshot">');
    });

    it('should constrain standalone icon images to their website display size', () => {
      const input = '![](https://developers.openai.com/images/codex/codex-banner-icon.webp)';
      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toBe(
        '![](https://developers.openai.com/images/codex/codex-banner-icon.webp){width=40px}'
      );
    });

    it('should constrain standalone screenshot images to page width', () => {
      const input = [
        '#### Agent internet access',
        '',
        '![](https://developers.openai.com/images/codex/changelog/internet_access.png)',
        '',
        'Now you can give Codex access to the internet during task execution.',
      ].join('\n');
      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toContain(
        '![](https://developers.openai.com/images/codex/changelog/internet_access.png){width=100%}'
      );
    });

    it('should not override existing image sizing attributes', () => {
      const input = '![](https://developers.openai.com/images/codex/changelog/internet_access.png){width=60%}';
      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toBe(
        '![](https://developers.openai.com/images/codex/changelog/internet_access.png){width=60%}'
      );
    });

    it('should keep standalone icon card titles inline with their icon', () => {
      const input = [
        '![](https://developers.openai.com/images/codex/codex-banner-icon.webp)',
        '',
        '### [Use the Codex app on Windows](https://developers.openai.com/codex/app/windows)',
        '',
        'Work across projects in the native Windows app.',
      ].join('\n');
      const result = service.normalizer._cleanMarkdownContent(input);

      expect(result).toBe(
        [
          '![](https://developers.openai.com/images/codex/codex-banner-icon.webp){width=40px} **[Use the Codex app on Windows](https://developers.openai.com/codex/app/windows)**',
          '',
          'Work across projects in the native Windows app.',
        ].join('\n')
      );
    });

    it('should preserve export/import lines inside fenced code blocks', () => {
      // Python example containing `import`, and shell `export VAR=...` must
      // survive because they are inside fenced code blocks.
      const input = [
        '# Example',
        '',
        '```python',
        'import json',
        'import sys',
        'print(json.dumps({"ok": True}))',
        '```',
        '',
        '```bash',
        'export MAX_TOKENS=50000',
        'claude',
        '```',
      ].join('\n');
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).toContain('import json');
      expect(result).toContain('import sys');
      expect(result).toContain('export MAX_TOKENS=50000');
    });

    it('should strip top-level MDX import statements', () => {
      service.config.markdownSource = { format: 'mdx' };
      const input = [
        "import Foo from '@site/components/Foo';",
        'import Bar from "./Bar";',
        '',
        '# Page title',
        'body',
      ].join('\n');
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).not.toMatch(/^import\s/m);
      expect(result).toContain('# Page title');
      expect(result).toContain('body');
    });

    it('should handle mixed backtick lengths correctly', () => {
      const input =
        '````markdown theme={null}\n' + '```bash\n' + 'echo "hello"\n' + '```\n' + '````';
      const expected = '````markdown\n' + '```bash\n' + 'echo "hello"\n' + '```\n' + '````';
      const result = service.normalizer._cleanMarkdownContent(input);
      expect(result).toBe(expected);
    });

    it('should preserve nested code fences when outer uses more backticks (MDX AST)', () => {
      service.config.markdownSource = { format: 'mdx' };
      // Regression: fenced examples must match closing delimiter to
      // the opener's character AND length. A 3-backtick line inside a
      // 4-backtick block must NOT end the protected region.
      const input = [
        '````markdown',
        'export const SHOULD_SURVIVE = true;',
        '```bash',
        'export VAR=1',
        '```',
        '````',
        '',
        "import Leak from './leak';",
      ].join('\n');
      const result = service.normalizer._stripMdxWithAst(input);
      // The export inside the 4-backtick block must survive
      expect(result).toContain('export const SHOULD_SURVIVE = true;');
      expect(result).toContain('export VAR=1');
      // The import outside the fence must be stripped
      expect(result).not.toMatch(/^import Leak/m);
    });

    it('should preserve Pandoc shorthand fenced divs in MDX source', () => {
      service.config.markdownSource = { format: 'mdx' };
      const input = [
        '::: english-annotation',
        '**英语批注 · 高中**',
        '',
        '- **under the hood**（惯用语）：表示内部实现。',
        ':::',
      ].join('\n');

      expect(service.normalizer._stripMdxWithAst(input)).toBe(input);
    });
  });

  describe('_preparePdfImages', () => {
    it('should rewrite unsafe markdown images to local png files when conversion succeeds', async () => {
      vi.spyOn(service, '_materializePdfSafeImage').mockResolvedValue('/tmp/converted/app.png');

      const result = await service._preparePdfImages(
        '![App screenshot](https://developers.openai.com/images/app.webp)',
        tempDir
      );

      expect(result.content).toBe('![App screenshot](/tmp/converted/app.png)');
      expect(result.cleanupPaths).toHaveLength(1);
    });

    it('should preserve markdown image titles while extracting only the image url', async () => {
      const materializeSpy = vi
        .spyOn(service, '_materializePdfSafeImage')
        .mockResolvedValue('/tmp/converted/app.png');

      const result = await service._preparePdfImages(
        '![App screenshot](https://developers.openai.com/images/app.webp "caption")',
        tempDir
      );

      expect(materializeSpy).toHaveBeenCalledWith(
        'https://developers.openai.com/images/app.webp',
        expect.stringContaining('media-')
      );
      expect(result.content).toBe('![App screenshot](/tmp/converted/app.png "caption")');
    });

    it('should preserve markdown image attributes when rewriting remote images', async () => {
      vi.spyOn(service, '_materializePdfSafeImage').mockResolvedValue('/tmp/converted/icon.png');

      const result = await service._preparePdfImages(
        '![](https://developers.openai.com/images/codex/codex-banner-icon.webp){width=40px}',
        tempDir
      );

      expect(result.content).toBe('![](/tmp/converted/icon.png){width=40px}');
    });

    it('rejects image conversion failures without replacing images with links', async () => {
      vi.spyOn(service, '_materializePdfSafeImage').mockRejectedValue(new Error('download failed'));
      await expect(service._preparePdfImages('![Image](https://example.com/image.webp)', tempDir))
        .rejects.toThrow('download failed');
    });

    it('should rewrite unsafe raw html img tags to local markdown images', async () => {
      vi.spyOn(service, '_materializePdfSafeImage').mockResolvedValue('/tmp/converted/review.png');

      const result = await service._preparePdfImages(
        '<img src="https://developers.openai.com/images/app.webp" alt="Review pane">',
        tempDir
      );

      expect(result.content).toBe('![Review pane](/tmp/converted/review.png)');
    });

    it('should not rewrite markdown or html image examples inside fenced code blocks', async () => {
      const materializeSpy = vi
        .spyOn(service, '_materializePdfSafeImage')
        .mockResolvedValue('/tmp/converted/review.png');

      const input = [
        '```md',
        '![Example](https://developers.openai.com/images/example.webp "caption")',
        '<img src="https://developers.openai.com/images/example-html.webp" alt="HTML example">',
        '```',
        '',
        '<img src="https://developers.openai.com/images/review.webp" alt="Review pane">',
      ].join('\n');

      const result = await service._preparePdfImages(input, tempDir);

      expect(materializeSpy).toHaveBeenCalledTimes(1);
      expect(materializeSpy).toHaveBeenCalledWith(
        'https://developers.openai.com/images/review.webp',
        expect.stringContaining('media-')
      );
      expect(result.content).toBe([
        '```md',
        '![Example](https://developers.openai.com/images/example.webp "caption")',
        '<img src="https://developers.openai.com/images/example-html.webp" alt="HTML example">',
        '```',
        '',
        '![Review pane](/tmp/converted/review.png)',
      ].join('\n'));
    });
  });

  describe('_extractPdfUnsafeImageUrls', () => {
    it('should extract only the image url when markdown image has an optional title', () => {
      expect(
        service.normalizer._extractPdfUnsafeImageUrls(
          '![App screenshot](https://developers.openai.com/images/app.webp "caption")'
        )
      ).toEqual(['https://developers.openai.com/images/app.webp']);
    });

    it('should ignore fenced code block image examples', () => {
      const input = [
        '```md',
        '![Example](https://developers.openai.com/images/example.webp)',
        '<img src="https://developers.openai.com/images/example-html.webp" alt="HTML example">',
        '```',
        '',
        '![Real](https://developers.openai.com/images/real.webp)',
      ].join('\n');

      expect(service.normalizer._extractPdfUnsafeImageUrls(input)).toEqual([
        'https://developers.openai.com/images/real.webp',
      ]);
    });
  });

  describe('_detectDownloadedImageFormat', () => {
    it('should detect webp from bytes even when headers are missing', () => {
      const webpBuffer = Buffer.concat([
        Buffer.from('RIFF', 'ascii'),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
        Buffer.from('WEBP', 'ascii'),
      ]);

      expect(service._detectDownloadedImageFormat(webpBuffer, '')).toBe('webp');
    });

    it('should still convert when the detected format is unsafe even if the url looks safe', () => {
      expect(
        service._shouldConvertDownloadedImage(
          'https://cdn.example.com/chart?fm=png',
          '',
          'webp'
        )
      ).toBe(true);
    });
  });

  describe('_runXeLatexUntilStable', () => {
    it('should run enough passes for TOC page numbers to converge', async () => {
      let pass = 0;
      const runSpy = vi.spyOn(service, '_runXeLatex').mockImplementation(async () => {
        pass += 1;
        fs.writeFileSync(path.join(tempDir, 'input.toc'), `page ${Math.min(pass, 2)}`);
      });

      await service._runXeLatexUntilStable(path.join(tempDir, 'input.tex'), tempDir);

      expect(runSpy).toHaveBeenCalledTimes(3);
    });

    it('should fail instead of accepting a non-converging TOC', async () => {
      let pass = 0;
      vi.spyOn(service, '_runXeLatex').mockImplementation(async () => {
        pass += 1;
        fs.writeFileSync(path.join(tempDir, 'input.toc'), `page ${pass}`);
      });

      await expect(
        service._runXeLatexUntilStable(path.join(tempDir, 'input.tex'), tempDir)
      ).rejects.toThrow('did not stabilize after 5 passes');
    });
  });

  describe('_runPandoc', () => {
    it.each([true, false])('cleans renderer files on success and missing output (%s)', async (createPdf) => {
      const inputPath = path.join(tempDir, 'input.md');
      const outputPath = path.join(tempDir, 'output.pdf');
      fs.writeFileSync(inputPath, '# Test');
      let headerPath;
      service.processRunner.run.mockImplementation(async (command, args) => {
        if (command === 'pandoc') {
          headerPath = args[args.indexOf('--include-in-header') + 1];
          expect(fs.existsSync(headerPath)).toBe(true);
          fs.writeFileSync(args[args.indexOf('-o') + 1], 'latex source');
        } else if (createPdf) {
          const outputDir = args.find((arg) => arg.startsWith('-output-directory=')).split('=')[1];
          fs.writeFileSync(path.join(outputDir, 'input.pdf'), '%PDF');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });
      if (createPdf) {
        await service._runPandoc(inputPath, outputPath);
        expect(fs.existsSync(outputPath)).toBe(true);
      } else {
        await expect(service._runPandoc(inputPath, outputPath)).rejects.toThrow('PDF 文件未生成');
      }
      expect(fs.existsSync(headerPath)).toBe(false);
      expect(service.processRunner.run).toHaveBeenCalledTimes(3);
    });
  });
});
