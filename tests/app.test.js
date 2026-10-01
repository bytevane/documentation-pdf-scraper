vi.mock('../src/services/pdf/pdfVerification.js', () => ({ verifyPdf: vi.fn().mockResolvedValue({ passed: true }) }));
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Application } from '../src/app.js';
import { verifyPdf } from '../src/services/pdf/pdfVerification.js';
import { createContainer, shutdownContainer, getContainerHealth } from '../src/core/setup.js';

vi.mock('../src/core/setup.js', () => ({
  createContainer: vi.fn(), shutdownContainer: vi.fn(), getContainerHealth: vi.fn(),
}));
vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('Application (real implementation)', () => {
  let app;
  let services;
  let processRef;
  beforeEach(() => {
    vi.clearAllMocks();
    processRef = Object.assign(new EventEmitter(), {
      exit: vi.fn(), memoryUsage: () => ({ rss: 1 }), pid: 123,
    });
    services = {
      processRunner: { dispose: vi.fn(), getRunningProcesses: () => [] },
      config: { pdfDir: 'pdfs', markdownPdf: { batchMode: true } },
      scraper: { run: vi.fn() },
      metadataService: { getArticleTitles: async () => ({ 0: 'Overview', 1: 'Guide' }),
        getSectionStructure: async () => ({ sections: [] }) },
      fileService: { ensureDirectory: vi.fn() },
      progressTracker: { getStats: () => ({ total: 1, succeeded: 1, failed: 0, skipped: 0 }) },
    };
    createContainer.mockResolvedValue({ get: async (name) => services[name] });
    getContainerHealth.mockReturnValue({ healthy: true });
    shutdownContainer.mockResolvedValue();
    app = new Application({ processRef });
  });
  afterEach(async () => { await app.cleanup(); });

  it('initializes without creating a second Python process manager', async () => {
    await app.initialize();
    expect(app.processRunner).toBe(services.processRunner);
    expect(app.getStatus()).toMatchObject({ status: 'running', processes: [], pid: 123 });
  });

  it('propagates initialization errors and cleans up', async () => {
    createContainer.mockRejectedValue(new Error('Invalid config'));
    await expect(app.initialize()).rejects.toThrow('Invalid config');
    expect(app.isShuttingDown).toBe(true);
  });

  it('runs the scraper and preserves success metric semantics', async () => {
    await app.initialize();
    const result = await app.runScraping();
    expect(services.scraper.run).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: true, stats: { succeeded: 1, total: 1 } });
  });

  it('does not generate a partial PDF when a page failed', async () => {
    services.progressTracker.getStats = () => ({ total: 2, succeeded: 1, failed: 1 });
    app.runBatchPdfGeneration = vi.fn();
    await expect(app.run()).rejects.toThrow('1 documentation pages failed');
    expect(app.runBatchPdfGeneration).not.toHaveBeenCalled();
  });

  it('does not generate PDF after a scraper exception', async () => {
    services.scraper.run.mockRejectedValue(new Error('Source unavailable'));
    app.runBatchPdfGeneration = vi.fn();
    await expect(app.run()).rejects.toThrow('Source unavailable');
    expect(app.runBatchPdfGeneration).not.toHaveBeenCalled();
  });

  it('does not merge via Python after a batch renderer error', async () => {
    app.runBatchPdfGeneration = vi.fn().mockResolvedValue({ success: false, error: 'Renderer failed' });
    app.runPythonMerge = vi.fn();
    await expect(app.run()).rejects.toThrow('Renderer failed');
    expect(app.runPythonMerge).not.toHaveBeenCalled();
  });

  it('does not report success after PDF verification fails', async () => {
    app.runBatchPdfGeneration = vi.fn().mockResolvedValue({ success: true, outputPath: 'output.pdf' });
    verifyPdf.mockRejectedValueOnce(new Error('PDF overflow'));
    await expect(app.run()).rejects.toThrow('PDF overflow');
  });

  it('checks title coverage across all merged files', async () => {
    await app.initialize();
    verifyPdf.mockResolvedValueOnce({ passed: true, foundTitles: ['Overview'] })
      .mockResolvedValueOnce({ passed: true, foundTitles: ['Guide'] });
    await expect(app.runPdfVerification(['first.pdf', 'second.pdf'], {})).resolves.toHaveLength(2);
    verifyPdf.mockResolvedValueOnce({ passed: true, foundTitles: ['Overview'] });
    await expect(app.runPdfVerification(['first.pdf'], {})).rejects.toThrow('missing article titles: Guide');
  });

  it('stops external processes before disposing the container and only once', async () => {
    await app.initialize();
    await app.cleanup();
    await app.cleanup();
    expect(services.processRunner.dispose).toHaveBeenCalledOnce();
    expect(shutdownContainer).toHaveBeenCalledOnce();
    expect(services.processRunner.dispose.mock.invocationCallOrder[0])
      .toBeLessThan(shutdownContainer.mock.invocationCallOrder[0]);
    expect(app.container).toBeNull();
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGQUIT', 131],
  ])('cleans up on %s and exits with %i', async (signal, exitCode) => {
    await app.initialize();
    await processRef.listeners(signal)[0]();
    expect(shutdownContainer).toHaveBeenCalledOnce();
    expect(processRef.exit).toHaveBeenCalledWith(exitCode);
  });

  it.each(['uncaughtException', 'unhandledRejection'])('reports fatal %s', async (signal) => {
    await app.initialize();
    await processRef.listeners(signal)[0](new Error('fatal'));
    expect(processRef.exit).toHaveBeenCalledWith(1);
  });

  it('returns failed health status if inspection fails', async () => {
    getContainerHealth.mockImplementation(() => { throw new Error('health failed'); });
    app.container = {};
    expect(await app.healthCheck()).toMatchObject({ healthy: false, error: 'health failed' });
  });
});
