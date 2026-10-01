import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnotationService } from '../../src/services/annotationService.js';
import { ValidationError } from '../../src/utils/errors.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function responseFor(segments, annotationsByText = new Map()) {
  return {
    segments: segments.map((segment) => ({
      segmentId: segment.segmentId,
      annotations: (annotationsByText.get(segment.text) || []).map((annotation) => ({
        learningPromptZh: '',
        ...annotation,
      })),
    })),
  };
}

describe('AnnotationService', () => {
  let cacheDir;
  let primaryClient;
  let fallbackClient;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotation-cache-'));
    primaryClient = { annotate: vi.fn() };
    fallbackClient = { annotate: vi.fn() };
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function createService(overrides = {}) {
    return new AnnotationService({
      config: {
        annotations: {
          enabled: true,
          provider: 'agy',
          model: 'gemini-3.7-flash-medium',
          level: 'high-school',
          density: 'standard',
          explanationLanguage: 'Simplified Chinese',
          fallback: {
            provider: 'codex',
            model: 'gpt-5.6-luna',
            reasoningEffort: 'xhigh',
          },
          ...overrides.annotations,
        },
      },
      cacheDir,
      logger,
      primaryClient,
      fallbackClient,
      ...overrides,
    });
  }

  it('does not leave a failed cache directory creation as an unhandled rejection', async () => {
    const notADirectory = path.join(cacheDir, 'file');
    await fs.writeFile(notADirectory, '');
    const service = createService({ cacheDir: path.join(notADirectory, 'cache') });

    // Vitest fails the run on unhandled rejections, so letting the mkdir settle is the check.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(service.cacheReady).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('annotates eligible English paragraphs and list prose without rewriting protected content', async () => {
    const markdown = [
      '---',
      'title: Under the hood',
      '---',
      '',
      '# Get the ball rolling',
      '',
      'The framework works under the hood with `secret phrase` and [native wording](https://example.com).',
      '',
      '- This gets the ball rolling quickly.',
      '',
      '| Name | Meaning |',
      '| --- | --- |',
      '| under the hood | internal |',
      '',
      '```js',
      'const phrase = "under the hood";',
      '```',
      '',
      '这是一个中文段落，不应该发送给模型。',
      '',
    ].join('\n');

    primaryClient.annotate.mockImplementation(({ segments }) => responseFor(segments, new Map([
      [segmentsText(markdown, 'The framework'), [{
        quote: 'under the hood',
        occurrence: 1,
        type: 'idiom',
        explanationZh: '表示系统内部实际发生的事情。',
        exampleEn: 'Under the hood, the app validates every file.',
      }]],
      ['This gets the ball rolling quickly.', [{
        quote: 'gets the ball rolling',
        occurrence: 1,
        type: 'idiom',
        explanationZh: '表示推动某件事开始。',
        exampleEn: 'A short demo gets the ball rolling.',
      }]],
    ])));

    const result = await createService().annotateMarkdown(markdown);
    const [{ segments }] = primaryClient.annotate.mock.calls.map(([input]) => input);

    expect(segments.map((segment) => segment.text)).toEqual([
      segmentsText(markdown, 'The framework'),
      'This gets the ball rolling quickly.',
    ]);
    expect(result).toContain(
      'The framework works <span class="english-annotation-source">under the hood</span> with `secret phrase`'
    );
    expect(result).toContain('::: english-annotation');
    expect(result).toContain('**英语批注 · 高中**');
    expect(result).toContain('**under the hood**（惯用语）');
    expect(result).toContain('**例句：** Under the hood, the app validates every file.');
    expect(result).toContain('  ::: english-annotation');
    expect(result).toContain(
      '- This <span class="english-annotation-source">gets the ball rolling</span> quickly.'
    );
    expect(result).toContain('const phrase = "under the hood";');
    expect(result).toContain('| under the hood | internal |');
    expect(result).toContain('这是一个中文段落，不应该发送给模型。');
    expect(result).not.toContain('\n\n\n- This gets the ball rolling');
  });

  it('adds normalized broad American IPA only to single-word vocabulary annotations', async () => {
    const ipaService = { lookup: vi.fn().mockResolvedValue('/ˈbʌndəl/') };
    primaryClient.annotate.mockImplementation(({ segments }) => responseFor(segments, new Map([
      [segments[0].text, [{
        quote: 'bundle',
        occurrence: 1,
        type: 'word',
        explanationZh: '表示一组、一捆，或把内容打包在一起。',
        exampleEn: 'The build tool bundles all scripts into one file.',
      }]],
    ])));

    const result = await createService({
      annotations: { includeIPA: true, ipaAccent: 'us' },
      ipaService,
    }).annotateMarkdown('The build tool can bundle all scripts into one file.\n');

    expect(ipaService.lookup).toHaveBeenCalledWith('bundle', 'us');
    expect(result).toContain('**bundle**（生词 · 美式 IPA /ˈbʌndəl/）');
  });

  it('renders British and American learner IPA when both accents are selected', async () => {
    const ipaService = {
      lookup: vi.fn().mockImplementation(async (_word, accent) => ({
        uk: '/ˈbʌndəl/',
        us: '/ˈbʌndəl/',
      })[accent]),
    };
    primaryClient.annotate.mockImplementation(({ segments }) => responseFor(segments, new Map([
      [segments[0].text, [{
        quote: 'bundle',
        occurrence: 1,
        type: 'word',
        explanationZh: '表示一组、一捆，或把内容打包在一起。',
        exampleEn: 'The build tool bundles all scripts into one file.',
      }]],
    ])));

    const result = await createService({
      annotations: { includeIPA: true, ipaAccent: 'both' },
      ipaService,
    }).annotateMarkdown('The build tool can bundle all scripts into one file.\n');

    expect(ipaService.lookup).toHaveBeenCalledWith('bundle', 'uk');
    expect(ipaService.lookup).toHaveBeenCalledWith('bundle', 'us');
    expect(result).toContain('生词 · 英式 IPA /ˈbʌndəl/ · 美式 IPA /ˈbʌndəl/');
  });

  it('keeps an available accent when the other selected dictionary has no entry', async () => {
    const ipaService = {
      lookup: vi.fn().mockImplementation(async (_word, accent) => (
        accent === 'us' ? '/oʊˈpeɪk/' : null
      )),
    };
    primaryClient.annotate.mockImplementation(({ segments }) => responseFor(segments, new Map([
      [segments[0].text, [{
        quote: 'opaque',
        occurrence: 1,
        type: 'word',
        explanationZh: '表示不透明或难以理解。',
        exampleEn: 'The internal format can seem opaque.',
      }]],
    ])));

    const result = await createService({
      annotations: { includeIPA: true, ipaAccent: 'both' },
      ipaService,
    }).annotateMarkdown('The opaque internal format becomes clearer with practice.\n');

    expect(result).toContain('生词 · 美式 IPA /oʊˈpeɪk/');
    expect(result).not.toContain('英式 IPA');
  });

  it('treats a complete empty response as valid and does not call the fallback', async () => {
    primaryClient.annotate.mockImplementation(({ segments }) => responseFor(segments));
    const markdown = 'This sentence is straightforward for university readers.\n';

    await expect(createService({
      annotations: { level: 'university' },
    }).annotateMarkdown(markdown)).resolves.toBe(markdown);
    expect(fallbackClient.annotate).not.toHaveBeenCalled();
  });

  it('supports higher-order annotations and adds a bounded active-recall review', async () => {
    const markdown = 'Even when the tests pass, the release can fail because production has different constraints.\n';
    primaryClient.annotate.mockImplementation(({ segments }) => responseFor(segments, new Map([[
      segments[0].text,
      [{
        quote: 'Even when the tests pass',
        occurrence: 1,
        type: 'discourse-logic',
        explanationZh: '用让步关系提醒读者：测试通过并不能保证生产发布成功。',
        exampleEn: 'Even when the plan looks complete, new evidence can change it.',
        learningPromptZh: '为什么这里用让步关系，而不是直接说发布会失败？',
      }],
    ]])));

    const result = await createService().annotateMarkdown(markdown);

    expect(result).toContain('**Even when the tests pass**（篇章逻辑）');
    expect(result).toContain('::: english-learning-review');
    expect(result).toContain('**学习回顾 · 先不看批注**');
    expect(result).toContain('为什么这里用让步关系，而不是直接说发布会失败？');
  });

  it('prioritizes higher-order questions in the three-item article review', () => {
    const service = createService();
    const segments = ['lexical-1', 'lexical-2', 'lexical-3', 'grammar'].map((segmentId) => ({
      segmentId,
    }));
    const results = new Map(segments.map(({ segmentId }, index) => [segmentId, [{
      quote: segmentId,
      type: index === 3 ? 'grammar-pattern' : 'word',
      learningPromptZh: `问题 ${index + 1}？`,
    }]]));

    const review = service._renderReviewBlock(segments, results);

    expect(review).toContain('1. **grammar**：问题 4？');
    expect(review).toContain('2. **lexical-1**：问题 1？');
    expect(review).toContain('3. **lexical-2**：问题 2？');
    expect(review).not.toContain('lexical-3');
  });

  it('requests selective multidimensional notes with contextual glosses and deep questions', async () => {
    primaryClient.annotate.mockImplementation(({ segments }) => responseFor(segments));

    await createService().annotateMarkdown(
      'A restrained annotation should focus on a genuinely useful expression.\n'
    );

    const [{ prompt, responseSchema }] = primaryClient.annotate.mock.calls.map(([input]) => input);
    expect(prompt).toContain('ceiling, not a quota');
    expect(prompt).toContain('grammar patterns, discourse logic, register and usage');
    expect(prompt).toContain('complete multiword expression');
    expect(prompt).toContain('context-specific in Simplified Chinese');
    expect(prompt).toContain('why/how/compare/what-if question');
    const annotationSchema = responseSchema.properties.segments.items
      .properties.annotations.items.properties;
    expect(annotationSchema.quote).toEqual({ type: 'string' });
    expect(annotationSchema.learningPromptZh).toEqual({ type: 'string' });
  });

  it.each([
    {
      label: 'non-Chinese explanations',
      invalid: {
        explanationZh: 'A generic English definition.',
        exampleEn: 'This is a natural example sentence.',
        learningPromptZh: '',
      },
    },
    {
      label: 'non-sentence English examples',
      invalid: {
        explanationZh: '表示在上下文中逐步处理问题。',
        exampleEn: 'Process.',
        learningPromptZh: '',
      },
    },
    {
      label: 'non-Chinese learning prompts',
      invalid: {
        explanationZh: '表示在上下文中逐步处理问题。',
        exampleEn: 'The team works through difficult cases.',
        learningPromptZh: 'Why is this useful?',
      },
    },
  ])('rejects $label before using the fallback', async ({ invalid }) => {
    primaryClient.annotate.mockImplementation(({ segments }) => responseFor(segments, new Map([[
      segments[0].text,
      [{
        quote: 'works through',
        occurrence: 1,
        type: 'phrasal-verb',
        ...invalid,
      }],
    ]])));
    fallbackClient.annotate.mockImplementation(({ segments }) => responseFor(segments));

    const markdown = 'The team works through difficult cases methodically.\n';
    await expect(createService().annotateMarkdown(markdown)).resolves.toBe(markdown);
    expect(fallbackClient.annotate).toHaveBeenCalledOnce();
  });

  it('retries AGY once when its envelope omits structured output', async () => {
    primaryClient.annotate
      .mockRejectedValueOnce(new ValidationError('Missing structured output', {
        reason: 'missing_structured_output',
        status: 'SUCCESS',
        keys: ['response', 'status'],
        responseLength: 42,
      }))
      .mockImplementationOnce(({ segments }) => responseFor(segments));

    const markdown = 'This sentence is straightforward for high-school readers.\n';
    await expect(createService().annotateMarkdown(markdown)).resolves.toBe(markdown);

    expect(primaryClient.annotate).toHaveBeenCalledTimes(2);
    expect(fallbackClient.annotate).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'AGY structured output missing; retrying primary once',
      expect.objectContaining({ responseLength: 42 })
    );
  });

  it('falls back after exactly one missing-structured-output retry', async () => {
    primaryClient.annotate.mockRejectedValue(new ValidationError('Missing structured output', {
      reason: 'missing_structured_output',
    }));
    fallbackClient.annotate.mockImplementation(({ segments }) => responseFor(segments));

    const markdown = 'This sentence is straightforward for high-school readers.\n';
    await expect(createService().annotateMarkdown(markdown)).resolves.toBe(markdown);

    expect(primaryClient.annotate).toHaveBeenCalledTimes(2);
    expect(fallbackClient.annotate).toHaveBeenCalledOnce();
  });

  it('does not retry AGY for a process failure', async () => {
    primaryClient.annotate.mockRejectedValue(new Error('AGY process failed'));
    fallbackClient.annotate.mockImplementation(({ segments }) => responseFor(segments));

    const markdown = 'This sentence is straightforward for high-school readers.\n';
    await expect(createService().annotateMarkdown(markdown)).resolves.toBe(markdown);

    expect(primaryClient.annotate).toHaveBeenCalledOnce();
    expect(fallbackClient.annotate).toHaveBeenCalledOnce();
  });

  it('falls back once when the primary anchors inside inline code', async () => {
    primaryClient.annotate.mockImplementation(({ segments }) => responseFor(segments, new Map([
      [segments[0].text, [{
        quote: 'secret phrase',
        occurrence: 1,
        type: 'native-expression',
        explanationZh: '不应该批注代码。',
        exampleEn: 'This should be rejected.',
      }]],
    ])));
    fallbackClient.annotate.mockImplementation(({ segments }) => responseFor(segments, new Map([
      [segments[0].text, [{
        quote: 'under the hood',
        occurrence: 1,
        type: 'idiom',
        explanationZh: '表示内部实现。',
        exampleEn: 'It works under the hood.',
      }]],
    ])));

    const result = await createService().annotateMarkdown(
      'It uses `secret phrase` under the hood for compatibility.\n'
    );

    expect(primaryClient.annotate).toHaveBeenCalledOnce();
    expect(fallbackClient.annotate).toHaveBeenCalledOnce();
    expect(result).toContain('**under the hood**（惯用语）');
    expect(result).toContain(
      '<span class="english-annotation-source">under the hood</span>'
    );
    expect(result).not.toContain('\n\n\n');
  });

  it('fails the page when both providers return invalid batches', async () => {
    const invalid = ({ segments }) => responseFor(segments, new Map([
      [segments[0].text, Array.from({ length: 3 }, (_, index) => ({
        quote: index === 0 ? 'takes' : 'shape',
        occurrence: 1,
        type: 'word',
        explanationZh: '超过 standard 密度上限。',
        exampleEn: 'The idea takes shape.',
      }))],
    ]));
    primaryClient.annotate.mockImplementation(invalid);
    fallbackClient.annotate.mockImplementation(invalid);

    await expect(createService().annotateMarkdown(
      'The idea takes shape under real-world constraints.\n'
    )).rejects.toThrow(/both annotation providers failed/i);
  });

  it('uses occurrence to resolve repeated phrases and caches validated results by level', async () => {
    primaryClient.annotate.mockImplementation(({ segments }) => responseFor(segments, new Map([
      [segments[0].text, [{
        quote: 'in practice',
        occurrence: 2,
        type: 'native-expression',
        explanationZh: '这里强调实际使用中的第二处语境。',
        exampleEn: 'In practice, the limit rarely matters.',
      }]],
    ])));
    const markdown = 'in practice this is rare, but in practice it still matters.\n';
    const service = createService();

    const first = await service.annotateMarkdown(markdown);
    const second = await service.annotateMarkdown(markdown);

    expect(first).toBe(second);
    expect(first).toContain(
      'in practice this is rare, but <span class="english-annotation-source">in practice</span> it still matters.'
    );
    expect(primaryClient.annotate).toHaveBeenCalledOnce();

    const universityClient = { annotate: vi.fn(({ segments }) => responseFor(segments)) };
    await createService({
      annotations: { level: 'university' },
      primaryClient: universityClient,
    }).annotateMarkdown(markdown);
    expect(universityClient.annotate).toHaveBeenCalledOnce();
  });
});

function segmentsText(markdown, startsWith) {
  return markdown.split('\n').find((line) => line.startsWith(startsWith));
}
