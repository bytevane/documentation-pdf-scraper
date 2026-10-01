import { describe, it, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';

// tests/services/metadataService.test.js
import { MetadataService } from '../../src/services/metadataService.js';

describe('MetadataService', () => {
  let metadataService;
  let mockFileService;
  let mockPathService;
  let mockLogger;

  beforeEach(() => {
    // Mock dependencies
    mockFileService = {
      readJson: vi.fn(),
      writeJson: vi.fn(),
      updateJson: vi.fn(),
      appendToJsonArray: vi.fn(),
      removeFromJsonArray: vi.fn(),
    };

    mockPathService = {
      getMetadataPath: vi.fn((type) => `/metadata/${type}.json`),
    };

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    metadataService = new MetadataService(mockFileService, mockPathService, mockLogger);
  });

  describe('saveArticleTitle', () => {
    test('saveArticleTitle should use atomic updateJson instead of read+write', async () => {
      mockFileService.updateJson = vi.fn().mockResolvedValue({});

      await metadataService.saveArticleTitle(2, '标题');

      expect(mockFileService.updateJson).toHaveBeenCalledWith(
        '/metadata/articleTitles.json',
        {},
        expect.any(Function),
        { recoverInvalidJson: true }
      );
    });

    test('应该保存文章标题', async () => {
      mockFileService.updateJson.mockResolvedValue({ 1: '旧标题', 2: '新文章标题' });

      await metadataService.saveArticleTitle(2, '新文章标题');

      expect(mockPathService.getMetadataPath).toHaveBeenCalledWith('articleTitles');
      expect(mockFileService.updateJson).toHaveBeenCalledWith(
        '/metadata/articleTitles.json',
        {},
        expect.any(Function),
        { recoverInvalidJson: true }
      );

      const updater = mockFileService.updateJson.mock.calls[0][2];
      const updated = updater({ 1: '旧标题' });
      expect(updated).toEqual({
        1: '旧标题',
        2: '新文章标题',
      });
      expect(mockLogger.info).toHaveBeenCalledWith('保存文章标题: [2] 新文章标题');
    });

    test('应该覆盖已存在的标题', async () => {
      mockFileService.updateJson.mockResolvedValue({ 1: '更新的标题' });

      await metadataService.saveArticleTitle(1, '更新的标题');

      const updater = mockFileService.updateJson.mock.calls[0][2];
      const updated = updater({ 1: '旧标题' });
      expect(updated).toEqual({
        1: '更新的标题',
      });
    });

    test('应该在空对象上保存标题', async () => {
      mockFileService.updateJson.mockResolvedValue({ 1: '第一个标题' });

      await metadataService.saveArticleTitle(1, '第一个标题');

      const updater = mockFileService.updateJson.mock.calls[0][2];
      const updated = updater({});
      expect(updated).toEqual({
        1: '第一个标题',
      });
    });
  });

  describe('getArticleTitles', () => {
    test('应该获取所有文章标题', async () => {
      const titles = { 1: '标题1', 2: '标题2' };
      mockFileService.readJson.mockResolvedValue(titles);

      const result = await metadataService.getArticleTitles();

      expect(mockPathService.getMetadataPath).toHaveBeenCalledWith('articleTitles');
      expect(mockFileService.readJson).toHaveBeenCalledWith('/metadata/articleTitles.json', {});
      expect(result).toEqual(titles);
    });

    test('应该在文件不存在时返回空对象', async () => {
      mockFileService.readJson.mockResolvedValue({});

      const result = await metadataService.getArticleTitles();

      expect(result).toEqual({});
    });
  });

  describe('logImageLoadFailure', () => {
    test('应该记录新的图片加载失败', async () => {
      mockFileService.readJson.mockResolvedValue([]);
      const mockDate = new Date('2024-03-15T10:00:00Z');
      const dateSpy = vi.spyOn(global, 'Date').mockImplementation(function MockDate() {
        return mockDate;
      });

      await metadataService.logImageLoadFailure('http://example.com/image.jpg', 3);

      expect(mockPathService.getMetadataPath).toHaveBeenCalledWith('imageLoadFailures');
      expect(mockFileService.readJson).toHaveBeenCalledWith('/metadata/imageLoadFailures.json', []);
      expect(mockFileService.writeJson).toHaveBeenCalledWith('/metadata/imageLoadFailures.json', [
        {
          url: 'http://example.com/image.jpg',
          index: 3,
          timestamp: '2024-03-15T10:00:00.000Z',
        },
      ]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '记录图片加载失败: http://example.com/image.jpg'
      );

      dateSpy.mockRestore();
    });

    test('应该避免重复记录', async () => {
      mockFileService.readJson.mockResolvedValue([
        { url: 'http://example.com/image.jpg', index: 3 },
      ]);

      await metadataService.logImageLoadFailure('http://example.com/image.jpg', 3);

      expect(mockFileService.writeJson).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('应该允许相同URL但不同index的记录', async () => {
      mockFileService.readJson.mockResolvedValue([
        { url: 'http://example.com/image.jpg', index: 3 },
      ]);

      await metadataService.logImageLoadFailure('http://example.com/image.jpg', 5);

      expect(mockFileService.writeJson).toHaveBeenCalledWith(
        '/metadata/imageLoadFailures.json',
        expect.arrayContaining([
          { url: 'http://example.com/image.jpg', index: 3 },
          expect.objectContaining({
            url: 'http://example.com/image.jpg',
            index: 5,
          }),
        ])
      );
    });
  });

});
