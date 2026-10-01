import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { createLogger } from '../utils/logger.js';
import { ProcessingError, ValidationError } from '../utils/errors.js';
import {
  AGY_ANNOTATION_ERROR_REASONS,
  AgyAnnotationClient,
} from './agyAnnotationClient.js';
import { CodexAnnotationClient } from './codexAnnotationClient.js';
import { IpaPronunciationService } from './ipaPronunciationService.js';
import {
  ANNOTATION_CONTRACT_VERSION,
  ANNOTATION_DENSITY_LIMITS,
  ANNOTATION_TYPES,
  createAnnotationResponseSchema,
} from './annotationContract.js';

const TYPE_LABELS = {
  word: '生词',
  'phrasal-verb': '短语动词',
  idiom: '惯用语',
  collocation: '搭配',
  'native-expression': '地道表达',
  'technical-term': '技术术语',
  slang: '俚语',
  'grammar-pattern': '语法结构',
  'discourse-logic': '篇章逻辑',
  'register-usage': '语域用法',
  'writing-pattern': '写作句型',
  concept: '关键概念',
};

const MAX_REVIEW_PROMPTS = 3;
const HIGHER_ORDER_TYPES = new Set([
  'grammar-pattern',
  'discourse-logic',
  'register-usage',
  'writing-pattern',
  'concept',
]);

const LEVEL_LABELS = {
  'junior-high': '初中',
  'high-school': '高中',
  university: '大学',
};

export class AnnotationService {
  constructor(options = {}) {
    this.config = options.config || {};
    this.annotationConfig = this.config.annotations || {};
    this.enabled = this.annotationConfig.enabled ?? false;
    this.level = this.annotationConfig.level || 'high-school';
    this.density = this.annotationConfig.density || 'standard';
    this.explanationLanguage = this.annotationConfig.explanationLanguage || 'Simplified Chinese';
    this.includeIPA = this.annotationConfig.includeIPA ?? false;
    this.ipaAccent = this.annotationConfig.ipaAccent || 'uk';
    this.maxAnnotations = ANNOTATION_DENSITY_LIMITS[this.density] || 2;
    this.logger = options.logger || createLogger('AnnotationService');
    this.cacheDir = options.cacheDir
      || options.pathService?.getAnnotationCacheDirectory?.()
      || path.join(process.cwd(), '.temp', 'annotation_cache');
    this.cacheMemory = new Map();
    this.cacheReady = this.enabled
      ? fs.mkdir(this.cacheDir, { recursive: true })
      : Promise.resolve();
    // Cache reads/writes await cacheReady and report its error; a service that never
    // touches the cache must not turn a failed mkdir into an unhandled rejection.
    this.cacheReady.catch(() => {});

    const fallback = this.annotationConfig.fallback || {};
    this.primaryClient = options.primaryClient || new AgyAnnotationClient({
      processRunner: options.processRunner,
      model: this.annotationConfig.model,
      timeoutMs: this.annotationConfig.timeout,
    });
    this.fallbackClient = options.fallbackClient || new CodexAnnotationClient({
      processRunner: options.processRunner,
      model: fallback.model,
      reasoningEffort: fallback.reasoningEffort,
      timeoutMs: this.annotationConfig.timeout,
    });
    this.ipaService = options.ipaService || new IpaPronunciationService({
      enabled: this.includeIPA,
      accent: this.ipaAccent === 'both' ? 'uk' : this.ipaAccent,
      cacheDir: path.join(this.cacheDir, 'ipa'),
      logger: this.logger,
    });
  }

  async annotateMarkdown(markdown) {
    if (!this.enabled || !markdown || typeof markdown !== 'string') return markdown;

    const segments = this._extractSegments(markdown);
    if (segments.length === 0) {
      this.logger.info('No eligible English prose found for annotations');
      return markdown;
    }

    const results = new Map();
    const uncached = [];
    for (const segment of segments) {
      const cached = await this._readCache(segment);
      if (cached) results.set(segment.segmentId, cached.annotations);
      else uncached.push(segment);
    }

    this.logger.info('English annotation cache lookup complete', {
      segments: segments.length,
      cacheHits: segments.length - uncached.length,
    });

    for (const batch of this._createBatches(uncached)) {
      const validated = await this._annotateBatch(batch);
      for (const segment of batch) {
        const entry = validated.byId.get(segment.segmentId);
        results.set(segment.segmentId, entry.annotations);
        await this._writeCache(segment, entry.annotations, validated.provider);
      }
    }

    await this._enrichResultsWithIpa(results);
    return this._renderMarkdown(markdown, segments, results);
  }

  async _enrichResultsWithIpa(results) {
    if (!this.includeIPA) return;
    const accents = this.ipaAccent === 'both' ? ['uk', 'us'] : [this.ipaAccent];
    const words = new Set();
    for (const annotations of results.values()) {
      for (const annotation of annotations) {
        if (annotation.type === 'word') words.add(annotation.quote);
      }
    }
    const pronunciations = new Map(await Promise.all([...words].map(async (word) => {
      const entries = await Promise.all(accents.map(async (accent) => [
        accent,
        await this.ipaService.lookup(word, accent),
      ]));
      return [word, Object.fromEntries(entries.filter(([, ipa]) => ipa))];
    })));
    for (const [segmentId, annotations] of results) {
      results.set(segmentId, annotations.map((annotation) => {
        const ipa = annotation.type === 'word' ? pronunciations.get(annotation.quote) : null;
        return ipa && Object.keys(ipa).length > 0 ? { ...annotation, ipa } : annotation;
      }));
    }
  }

  _extractSegments(markdown) {
    const tree = fromMarkdown(markdown);
    const frontmatterEnd = findFrontmatterEnd(markdown);
    const segments = [];

    const visit = (node, ancestors = []) => {
      const parent = ancestors.at(-1);
      if (node.type === 'paragraph' && (parent?.type === 'root' || parent?.type === 'listItem')) {
        const start = node.position.start.offset;
        const end = node.position.end.offset;
        const text = markdown.slice(start, end);
        if (start >= frontmatterEnd && !looksLikePipeTable(text)) {
          const protectedRanges = collectProtectedRanges(node, text, start);
          if (isEligibleEnglish(text, protectedRanges)) {
            segments.push({
              segmentId: `segment-${String(segments.length + 1).padStart(4, '0')}`,
              text,
              start,
              end,
              insertOffset: end,
              indent: parent.type === 'listItem'
                ? ' '.repeat(Math.max(0, node.position.start.column - 1))
                : '',
              protectedRanges,
            });
          }
        }
      }
      node.children?.forEach((child) => visit(child, [...ancestors, node]));
    };
    visit(tree);
    return segments;
  }

  _createBatches(segments) {
    const batches = [];
    let batch = [];
    let characters = 0;
    for (const segment of segments) {
      if (batch.length > 0 && (batch.length >= 12 || characters + segment.text.length > 6000)) {
        batches.push(batch);
        batch = [];
        characters = 0;
      }
      batch.push(segment);
      characters += segment.text.length;
    }
    if (batch.length > 0) batches.push(batch);
    return batches;
  }

  async _annotateBatch(batch) {
    const responseSchema = createAnnotationResponseSchema(this.maxAnnotations, batch.length);
    const prompt = this._buildPrompt(batch);
    let primaryError;
    try {
      const response = await this._annotateWithPrimaryRetry({ prompt, responseSchema, batch });
      const validated = { byId: this._validateBatchResponse(batch, response), provider: 'agy' };
      this.logger.info('Annotation batch validated', {
        provider: validated.provider,
        segments: batch.length,
      });
      return validated;
    } catch (error) {
      primaryError = error;
      this.logger.warn('Primary annotation provider failed; trying fallback', {
        provider: 'agy',
        reason: error.message,
      });
    }

    try {
      const response = await this.fallbackClient.annotate({ prompt, responseSchema, segments: batch });
      const validated = { byId: this._validateBatchResponse(batch, response), provider: 'codex' };
      this.logger.info('Annotation fallback batch validated', {
        provider: validated.provider,
        segments: batch.length,
      });
      return validated;
    } catch (fallbackError) {
      const primaryMessage = primaryError?.message || 'unknown primary error';
      throw new ProcessingError(
        `Both annotation providers failed (AGY: ${primaryMessage}; Codex: ${fallbackError.message})`,
        {
        primary: primaryError?.message,
        fallback: fallbackError.message,
        }
      );
    }
  }

  async _annotateWithPrimaryRetry({ prompt, responseSchema, batch }) {
    const input = { prompt, responseSchema, segments: batch };
    try {
      return await this.primaryClient.annotate(input);
    } catch (error) {
      if (error?.details?.reason
          !== AGY_ANNOTATION_ERROR_REASONS.MISSING_STRUCTURED_OUTPUT) {
        throw error;
      }
      this.logger.warn('AGY structured output missing; retrying primary once', {
        provider: 'agy',
        status: error.details.status,
        keys: error.details.keys,
        responseLength: error.details.responseLength,
      });
      return this.primaryClient.annotate(input);
    }
  }

  _buildPrompt(batch) {
    const levelGuidance = {
      'junior-high': 'Explain useful expressions beyond junior-high English and clear, reusable sentence patterns.',
      'high-school': 'Skip basic vocabulary; focus on reusable phrases, grammar, discourse logic, register, and writing patterns.',
      university: 'Annotate only opaque, technical, pragmatically special, structurally instructive, or conceptually important targets.',
    }[this.level];
    const densityGuidance = {
      light: 'Most segments should have zero notes; use one only when it has clear learning value.',
      standard: 'Use zero or one note in most segments; use a second only for an independent high-value target.',
      dense: 'Remain selective even with a higher ceiling; do not fill available slots automatically.',
    }[this.density];
    const payload = batch.map(({ segmentId, text, protectedRanges }) => ({
      segmentId,
      markdown: text,
      protectedRanges,
    }));
    return [
      'Create restrained English-learning annotations for the supplied Markdown prose.',
      `Reader level: ${this.level}. ${levelGuidance}`,
      `Explanation language: ${this.explanationLanguage}.`,
      `Return at most ${this.maxAnnotations} annotations per segment; zero is valid and preferred over a basic or forced note.`,
      `Treat the maximum as a ceiling, not a quota. ${densityGuidance}`,
      'Targets may be vocabulary units or higher-order learning targets: grammar patterns, discourse logic, register and usage, reusable writing patterns, and critical domain concepts.',
      'For a higher-order target, quote the shortest exact span that still makes the structure or idea identifiable.',
      'Prefer the complete multiword expression over a less useful word inside it.',
      'Do not annotate proper names, product labels, transparent phrases, standard terms likely known at the reader level, or a quote already selected elsewhere in this batch unless it has a genuinely different meaning.',
      'Make explanationZh concise and context-specific in Simplified Chinese. Make exampleEn a short, natural new sentence rather than copying the source.',
      'learningPromptZh may be empty. Use a short Chinese why/how/compare/what-if question only for a high-value target that benefits from active recall or self-explanation.',
      'Use a non-empty learningPromptZh for at most one annotation per segment. Do not include the answer in the question.',
      'Every requested segmentId must appear exactly once, including segments with an empty annotations array.',
      'Each quote must be a case-sensitive exact substring of markdown and occurrence is one-based.',
      'Never select text intersecting protectedRanges. Do not annotate Markdown syntax, code, URLs, or link destinations.',
      'Use only the response schema. Do not rewrite or translate the original prose.',
      JSON.stringify({ segments: payload }),
    ].join('\n\n');
  }

  _validateBatchResponse(batch, response) {
    if (!response || !hasOnlyKeys(response, ['segments']) || !Array.isArray(response.segments)) {
      throw new ValidationError('Annotation response must contain a segments array');
    }
    const requested = new Map(batch.map((segment) => [segment.segmentId, segment]));
    if (response.segments.length !== requested.size) {
      throw new ValidationError('Annotation response did not cover every requested segment');
    }

    const validated = new Map();
    for (const result of response.segments) {
      if (!result || !hasOnlyKeys(result, ['segmentId', 'annotations'])
          || typeof result.segmentId !== 'string' || validated.has(result.segmentId)) {
        throw new ValidationError('Annotation response contains a duplicate or invalid segmentId');
      }
      const segment = requested.get(result.segmentId);
      if (!segment) throw new ValidationError(`Unexpected annotation segmentId: ${result.segmentId}`);
      if (!Array.isArray(result.annotations) || result.annotations.length > this.maxAnnotations) {
        throw new ValidationError(`Annotation density exceeded for ${result.segmentId}`);
      }

      const ranges = [];
      const annotations = result.annotations.map((annotation) => {
        const normalized = validateAnnotationShape(annotation);
        const range = locateOccurrence(segment.text, normalized.quote, normalized.occurrence);
        if (!range) throw new ValidationError(`Annotation quote not found for ${result.segmentId}`);
        if (segment.protectedRanges.some((protectedRange) => overlaps(range, protectedRange))) {
          throw new ValidationError(`Annotation quote intersects protected Markdown for ${result.segmentId}`);
        }
        if (ranges.some((existing) => overlaps(range, existing))) {
          throw new ValidationError(`Annotation quotes overlap for ${result.segmentId}`);
        }
        ranges.push(range);
        return normalized;
      });
      if (annotations.filter((annotation) => annotation.learningPromptZh).length > 1) {
        throw new ValidationError(`Too many learning prompts for ${result.segmentId}`);
      }
      validated.set(result.segmentId, { annotations });
    }
    return validated;
  }

  _renderMarkdown(markdown, segments, results) {
    const edits = [];
    for (const segment of segments) {
      const annotations = results.get(segment.segmentId) || [];
      const block = this._renderBlock(segment, annotations);
      if (!block) continue;

      const after = markdown.slice(segment.insertOffset);
      const suffix = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n'
        : after ? '\n\n' : '\n';
      edits.push({
        start: segment.insertOffset,
        end: segment.insertOffset,
        replacement: `\n\n${block}${suffix}`,
      });

      for (const annotation of annotations) {
        const range = locateOccurrence(segment.text, annotation.quote, annotation.occurrence);
        const source = segment.text.slice(range.start, range.end);
        edits.push({
          start: segment.start + range.start,
          end: segment.start + range.end,
          replacement: `<span class="english-annotation-source">${source}</span>`,
        });
      }
    }
    edits.sort((left, right) => right.start - left.start || right.end - left.end);

    let output = markdown;
    for (const edit of edits) {
      output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
    }

    const review = this._renderReviewBlock(segments, results);
    if (!review) return output;
    const separator = output.endsWith('\n\n') ? '' : output.endsWith('\n') ? '\n' : '\n\n';
    return `${output}${separator}${review}\n`;
  }

  _renderBlock(segment, annotations) {
    if (annotations.length === 0) return '';
    const prefix = segment.indent;
    const lines = [
      `${prefix}::: english-annotation`,
      `${prefix}**英语批注 · ${LEVEL_LABELS[this.level]}**`,
      prefix,
    ];
    annotations.forEach((annotation) => {
      const ipaLabel = formatIpaLabel(annotation.ipa);
      lines.push(
        `${prefix}- **${escapeMarkdown(annotation.quote)}**（${TYPE_LABELS[annotation.type]}${ipaLabel}）：${escapeMarkdown(annotation.explanationZh)}`,
        prefix,
        `${prefix}  **例句：** ${escapeMarkdown(annotation.exampleEn)}`
      );
    });
    lines.push(`${prefix}:::`);
    return lines.join('\n');
  }

  _renderReviewBlock(segments, results) {
    const candidates = [];
    for (const segment of segments) {
      for (const annotation of results.get(segment.segmentId) || []) {
        if (!annotation.learningPromptZh) continue;
        candidates.push(annotation);
      }
    }
    const prompts = [
      ...candidates.filter((annotation) => HIGHER_ORDER_TYPES.has(annotation.type)),
      ...candidates.filter((annotation) => !HIGHER_ORDER_TYPES.has(annotation.type)),
    ].slice(0, MAX_REVIEW_PROMPTS);
    if (prompts.length === 0) return '';

    const lines = [
      '::: english-learning-review',
      '**学习回顾 · 先不看批注**',
      '',
      '用自己的话回答；答不出时，再回看上方对应批注。',
      '',
    ];
    prompts.forEach((annotation, index) => {
      lines.push(
        `${index + 1}. **${escapeMarkdown(annotation.quote)}**：${escapeMarkdown(annotation.learningPromptZh)}`
      );
    });
    lines.push(':::');
    return lines.join('\n');
  }

  _cacheKey(segment) {
    const fallback = this.annotationConfig.fallback || {};
    return createHash('sha256').update(JSON.stringify({
      text: segment.text,
      provider: this.annotationConfig.provider || 'agy',
      model: this.annotationConfig.model || 'gemini-3.7-flash-medium',
      fallbackProvider: fallback.provider || 'codex',
      fallbackModel: fallback.model || 'gpt-5.6-luna',
      fallbackReasoningEffort: fallback.reasoningEffort || 'xhigh',
      level: this.level,
      density: this.density,
      explanationLanguage: this.explanationLanguage,
      contractVersion: ANNOTATION_CONTRACT_VERSION,
    })).digest('hex');
  }

  async _readCache(segment) {
    const key = this._cacheKey(segment);
    if (this.cacheMemory.has(key)) return this.cacheMemory.get(key);
    try {
      await this.cacheReady;
      const payload = JSON.parse(await fs.readFile(path.join(this.cacheDir, `${key}.json`), 'utf8'));
      const byId = this._validateBatchResponse([segment], {
        segments: [{ segmentId: segment.segmentId, annotations: payload.annotations }],
      });
      const cached = {
        annotations: byId.get(segment.segmentId).annotations,
        provider: payload.provider,
      };
      this.cacheMemory.set(key, cached);
      return cached;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger.warn('Ignoring invalid annotation cache entry', { error: error.message });
      }
      return null;
    }
  }

  async _writeCache(segment, annotations, provider) {
    const key = this._cacheKey(segment);
    const cachePath = path.join(this.cacheDir, `${key}.json`);
    const temporaryPath = `${cachePath}.tmp-${randomUUID()}`;
    const payload = { annotations, provider, contractVersion: ANNOTATION_CONTRACT_VERSION };
    await this.cacheReady;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(payload), 'utf8');
      await fs.rename(temporaryPath, cachePath);
      this.cacheMemory.set(key, { annotations, provider });
    } catch (error) {
      this.logger.warn('Failed to write annotation cache entry', { error: error.message });
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}

function formatIpaLabel(pronunciations) {
  if (!pronunciations) return '';
  return ['uk', 'us']
    .filter((accent) => pronunciations[accent])
    .map((accent) => ` · ${accent === 'uk' ? '英式' : '美式'} IPA ${escapeMarkdown(pronunciations[accent])}`)
    .join('');
}

function findFrontmatterEnd(markdown) {
  let offset = 0;
  const lines = markdown.split(/(?<=\n)/);
  if ((lines[0] || '').trim() !== '---') return 0;
  offset += lines[0].length;
  for (const line of lines.slice(1)) {
    offset += line.length;
    if (line.trim() === '---') return offset;
  }
  return 0;
}

function looksLikePipeTable(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2 || !lines.every((line) => line.includes('|'))) return false;
  const delimiterCells = lines[1].split('|').filter((cell) => cell.trim());
  return delimiterCells.length > 0
    && delimiterCells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function collectProtectedRanges(node, text, baseOffset) {
  const ranges = [];
  const addNode = (child, kind) => ranges.push({
    start: child.position.start.offset - baseOffset,
    end: child.position.end.offset - baseOffset,
    kind,
  });
  const visit = (child) => {
    if (child.type === 'inlineCode' || child.type === 'html' || child.type === 'image') {
      addNode(child, child.type);
      return;
    }
    if (child.type === 'link' || child.type === 'linkReference') {
      const start = child.position.start.offset - baseOffset;
      const raw = text.slice(start, child.position.end.offset - baseOffset);
      const destinationStart = raw.lastIndexOf(']');
      if (/^<https?:\/\//i.test(raw) || destinationStart === -1) addNode(child, 'url');
      else ranges.push({ start: start + destinationStart + 1, end: start + raw.length, kind: 'url' });
      child.children?.forEach(visit);
      return;
    }
    child.children?.forEach(visit);
  };
  node.children?.forEach(visit);
  for (const match of text.matchAll(/https?:\/\/[^\s<>)\]]+/gi)) {
    ranges.push({ start: match.index, end: match.index + match[0].length, kind: 'url' });
  }
  return mergeRanges(ranges);
}

function mergeRanges(ranges) {
  const sorted = ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function isEligibleEnglish(text, protectedRanges) {
  let prose = text;
  for (const range of [...protectedRanges].sort((a, b) => b.start - a.start)) {
    prose = prose.slice(0, range.start) + ' '.repeat(range.end - range.start) + prose.slice(range.end);
  }
  const letters = prose.match(/\p{L}/gu) || [];
  const latinLetters = prose.match(/[A-Za-z]/g) || [];
  const words = prose.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g) || [];
  return words.length >= 3 && latinLetters.length >= 8
    && (letters.length === 0 || latinLetters.length / letters.length >= 0.7);
}

function validateAnnotationShape(annotation) {
  if (!annotation || typeof annotation !== 'object'
      || !hasOnlyKeys(annotation, [
        'quote',
        'occurrence',
        'type',
        'explanationZh',
        'exampleEn',
        'learningPromptZh',
      ])) {
    throw new ValidationError('Annotation must be an object');
  }
  const { quote, occurrence, type, explanationZh, exampleEn, learningPromptZh } = annotation;
  if (typeof quote !== 'string' || quote.length < 1 || quote.length > 120) {
    throw new ValidationError('Annotation quote length is invalid');
  }
  if (!Number.isInteger(occurrence) || occurrence < 1) {
    throw new ValidationError('Annotation occurrence must be a positive integer');
  }
  if (!ANNOTATION_TYPES.includes(type)) throw new ValidationError(`Unsupported annotation type: ${type}`);
  if (typeof explanationZh !== 'string' || explanationZh.length < 1 || explanationZh.length > 240) {
    throw new ValidationError('Annotation explanation length is invalid');
  }
  if (!/\p{Script=Han}/u.test(explanationZh)) {
    throw new ValidationError('Annotation explanation must contain Chinese');
  }
  if (typeof exampleEn !== 'string' || exampleEn.length < 1 || exampleEn.length > 240) {
    throw new ValidationError('Annotation example length is invalid');
  }
  const exampleWords = exampleEn.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g) || [];
  if (exampleWords.length < 3) {
    throw new ValidationError('Annotation example must be an English sentence');
  }
  if (typeof learningPromptZh !== 'string' || learningPromptZh.length > 160) {
    throw new ValidationError('Annotation learning prompt length is invalid');
  }
  const normalizedPrompt = learningPromptZh.trim();
  if (normalizedPrompt && !/\p{Script=Han}/u.test(normalizedPrompt)) {
    throw new ValidationError('Annotation learning prompt must contain Chinese');
  }
  return {
    quote,
    occurrence,
    type,
    explanationZh,
    exampleEn,
    learningPromptZh: normalizedPrompt,
  };
}

function locateOccurrence(text, quote, occurrence) {
  let from = 0;
  let start = -1;
  for (let index = 0; index < occurrence; index += 1) {
    start = text.indexOf(quote, from);
    if (start === -1) return null;
    from = start + quote.length;
  }
  return { start, end: start + quote.length };
}

function overlaps(left, right) {
  return left.start < right.end && left.end > right.start;
}

function hasOnlyKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key))
    && allowedKeys.every((key) => Object.hasOwn(value, key));
}

function escapeMarkdown(value) {
  return String(value).replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]]/g, '\\$&');
}
