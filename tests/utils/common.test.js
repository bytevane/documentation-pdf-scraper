import { describe, it, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';

// tests/utils/common.test.js
import {
  delay,
  retry,
  isIgnored,
  applyJitter,
} from '../../src/utils/common.js';

describe('Common Utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('delay', () => {
    test('应该延迟指定的毫秒数', async () => {
      const promise = delay(1000);

      // 使用 vi.advanceTimersByTime 而不是直接检查 setTimeout
      vi.advanceTimersByTime(1000);
      await promise;
    });
  });

  describe('retry', () => {
    beforeEach(() => {
      vi.useRealTimers(); // retry tests need real timers
    });

    afterEach(() => {
      vi.useFakeTimers();
    });

    test('应该在第一次成功时返回结果', async () => {
      const fn = vi.fn().mockResolvedValue('success');

      const result = await retry(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('should rethrow at once when shouldRetry returns false', async () => {
      const permanent = new Error('permanent');
      const fn = vi.fn().mockRejectedValue(permanent);
      const onRetry = vi.fn();

      await expect(
        retry(fn, { delay: 10, onRetry, shouldRetry: (error) => error !== permanent })
      ).rejects.toBe(permanent);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
    });

    test('应该重试失败的函数', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('First fail'))
        .mockRejectedValueOnce(new Error('Second fail'))
        .mockResolvedValue('success');

      const result = await retry(fn, { delay: 10 }); // 使用短延迟

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    test('应该在所有尝试失败后抛出最后的错误', async () => {
      const lastError = new Error('Final error');
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockRejectedValue(lastError);

      await expect(retry(fn, { maxAttempts: 3, delay: 10 })).rejects.toThrow('Final error');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    test('应该使用指数退避', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValue('success');

      const result = await retry(fn, { delay: 10, backoff: 2 });

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    test('应该调用onRetry回调', async () => {
      const onRetry = vi.fn();
      const error = new Error('Test error');
      const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('success');

      await retry(fn, { onRetry, delay: 10, jitterStrategy: 'none' });

      // 新签名包含 waitTime 作为第三个参数
      expect(onRetry).toHaveBeenCalledWith(1, error, expect.any(Number));
    });

    test('decorrelated jitter 应该遵守 maxDelay 上限', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValue('success');

      const waits = [];
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);

      const result = await retry(fn, {
        maxAttempts: 3,
        delay: 50,
        backoff: 3,
        maxDelay: 100,
        jitterStrategy: 'decorrelated',
        onRetry: (attempt, error, waitTime) => {
          waits.push(waitTime);
        },
      });

      randomSpy.mockRestore();

      expect(result).toBe('success');
      expect(waits.length).toBe(2);
      waits.forEach((w) => {
        expect(w).toBeLessThanOrEqual(100);
        expect(w).toBeGreaterThan(0);
      });
    });
  });

  describe('applyJitter', () => {
    test('strategy 为 none 时应返回 baseDelay', () => {
      expect(applyJitter(1000, 'none')).toBe(1000);
    });

    test('full jitter 应该在 [0, baseDelay] 范围内', () => {
      const mockRandom = vi.spyOn(Math, 'random');

      mockRandom.mockReturnValue(0);
      expect(applyJitter(1000, 'full')).toBe(0);

      mockRandom.mockReturnValue(1);
      expect(applyJitter(1000, 'full')).toBe(1000);

      mockRandom.mockRestore();
    });

    test('equal jitter 应该在 [base/2, base] 范围内', () => {
      const mockRandom = vi.spyOn(Math, 'random');

      mockRandom.mockReturnValue(0);
      expect(applyJitter(1000, 'equal')).toBe(500);

      mockRandom.mockReturnValue(1);
      expect(applyJitter(1000, 'equal')).toBe(1000);

      mockRandom.mockRestore();
    });

    test('decorrelated jitter 应该在 [base, prev*3] 范围内', () => {
      const mockRandom = vi.spyOn(Math, 'random');

      // 最小值：base
      mockRandom.mockReturnValue(0);
      expect(applyJitter(1000, 'decorrelated', 2000)).toBe(1000);

      // 最大值：3 * prev
      mockRandom.mockReturnValue(1);
      expect(applyJitter(1000, 'decorrelated', 2000)).toBe(6000);

      mockRandom.mockRestore();
    });
  });

  describe('isIgnored', () => {
    test('应该识别被忽略的URL', () => {
      const ignoreURLs = ['/api/deprecated', '/test', 'localhost'];

      expect(isIgnored('https://example.com/api/deprecated/v1', ignoreURLs)).toBe(true);
      expect(isIgnored('https://example.com/test/page', ignoreURLs)).toBe(true);
      expect(isIgnored('http://localhost:3000', ignoreURLs)).toBe(true);
    });

    test('应该不忽略未匹配的URL', () => {
      const ignoreURLs = ['/api/deprecated', '/test'];

      expect(isIgnored('https://example.com/api/v2', ignoreURLs)).toBe(false);
      expect(isIgnored('https://example.com/docs', ignoreURLs)).toBe(false);
    });

    test('应该处理空的忽略列表', () => {
      expect(isIgnored('https://example.com/any', [])).toBe(false);
    });
  });

});
