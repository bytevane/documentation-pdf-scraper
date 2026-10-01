import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PythonMergeService } from '../../src/services/PythonMergeService.js';

const merged = { success: true, mergedFiles: ['docs.pdf'], filesProcessed: 2, totalPages: 10 };

describe('PythonMergeService (real implementation)', () => {
  let service;
  let runner;
  beforeEach(() => {
    runner = { run: vi.fn().mockResolvedValue({ stdout: JSON.stringify(merged), exitCode: 0 }), dispose: vi.fn() };
    const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
    service = new PythonMergeService({ python: { executable: 'selected-python', timeout: 1234 } }, logger, runner);
  });

  it('delegates Python commands to the shared runner with timeout and progress', async () => {
    const progress = vi.fn();
    service.on('progress', progress);
    runner.run.mockImplementation(async (_command, _args, options) => {
      options.onStdout('Progress: 1/2 files processed');
      return { stdout: 'Log output\n' + JSON.stringify(merged), exitCode: 0 };
    });
    expect(await service.mergePDFs({ config: 'config.json', directory: 'docs' })).toEqual(merged);
    expect(runner.run).toHaveBeenCalledWith('selected-python', [
      service.mergerScript, '--config', 'config.json', '--directory', 'docs',
    ], expect.objectContaining({ timeoutMs: 1234, signal: expect.any(AbortSignal) }));
    expect(progress).toHaveBeenCalledWith({ current: 1, total: 2, percentage: 50 });
    expect(service.getStatus().statistics).toMatchObject({ successfulRuns: 1, totalFilesProcessed: 2 });
  });

  it.each(['PDF saved as: docs.pdf', '{broken', JSON.stringify({ ...merged, success: false }),
    JSON.stringify({ ...merged, totalPages: 0 }), JSON.stringify({ ...merged, mergedFiles: [null] }),
    JSON.stringify({ ...merged, mergedFiles: [] })])('rejects invalid results instead of parsing a legacy text format: %s', async (stdout) => {
    runner.run.mockResolvedValue({ stdout, exitCode: 0 });
    await expect(service.mergePDFs()).rejects.toThrow();
    expect(service.statistics.failedRuns).toBe(1);
    expect(service.isRunning).toBe(false);
  });

  it('propagates process failures and emits mergeError', async () => {
    const error = new Error('Python timed out');
    const listener = vi.fn();
    service.on('mergeError', listener);
    runner.run.mockRejectedValue(error);
    await expect(service.mergePDFs()).rejects.toThrow(error);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ error: error.message }));
  });

  it('cancels only the active merge and prevents overlapping merges', async () => {
    runner.run.mockImplementation((_command, _args, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const job = service.mergePDFs();
    const rejected = expect(job).rejects.toThrow('cancelled');
    await expect(service.mergePDFs()).rejects.toThrow('正在运行');
    expect(await service.stopMerge()).toBe(true);
    await rejected;
    expect(await service.stopMerge()).toBe(false);
  });

  it('disposes the runner without a fixed grace period', async () => {
    await service.dispose();
    expect(runner.dispose).toHaveBeenCalledOnce();
  });
});
