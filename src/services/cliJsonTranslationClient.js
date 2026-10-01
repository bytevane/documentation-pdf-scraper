import { spawn as defaultSpawn } from 'child_process';

/**
 * Shared process runner for translation CLIs that accept JSON on stdin and
 * return a JSON object on stdout.
 */
export class CliJsonTranslationClient {
  constructor(options = {}) {
    this.command = options.command;
    this.displayName = options.displayName || options.command;
    this.buildArgs = options.buildArgs || (() => []);
    this.timeoutMs = options.timeoutMs || 60000;
    this.logger = options.logger;
    this.spawn = options.spawn || defaultSpawn;
    this.children = new Set();
    this.disposed = false;
  }

  /** Kill running CLI processes so shutdown does not leave them behind. */
  dispose() {
    this.disposed = true;
    for (const child of this.children) child.kill('SIGKILL');
    this.children.clear();
  }

  async translateJson({ instructions, inputMap }) {
    const jsonInput = JSON.stringify(inputMap, null, 2);
    const startTime = Date.now();

    if (this.disposed) {
      throw new Error(`${this.displayName} client is disposed`);
    }

    return new Promise((resolve, reject) => {
      const child = this.spawn(this.command, this.buildArgs(instructions));
      this.children.add(child);
      let finished = false;
      let timedOut = false;
      let escalationTimer;
      let stdout = '';
      let stderr = '';

      const finish = (callback) => {
        if (finished) return;
        finished = true;
        this.children.delete(child);
        clearTimeout(timeoutTimer);
        clearTimeout(escalationTimer);
        callback();
      };

      const timeoutTimer = setTimeout(() => {
        if (finished) return;
        timedOut = true;
        this.logger?.warn('Translation timeout, terminating process', {
          client: this.displayName,
          timeoutMs: this.timeoutMs,
          elapsed: Date.now() - startTime,
        });
        child.kill('SIGTERM');
        escalationTimer = setTimeout(() => {
          if (!finished) child.kill('SIGKILL');
        }, 1000);
        escalationTimer.unref?.();
      }, this.timeoutMs);
      timeoutTimer.unref?.();

      try {
        child.stdin.write(jsonInput);
        child.stdin.end();
      } catch (error) {
        finish(() => {
          this.logger?.error(`Failed to write to ${this.displayName} stdin`, {
            error: error.message,
          });
          reject(error);
        });
        return;
      }

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code, signal) => {
        finish(() => {
          if (timedOut) {
            reject(new Error(`Translation timed out after ${this.timeoutMs}ms`));
            return;
          }
          if (code !== 0) {
            this.logger?.error(`${this.displayName} exited with error`, {
              code,
              signal,
              stderr: stderr.substring(0, 500),
              elapsed: Date.now() - startTime,
            });
            reject(
              new Error(`${this.displayName} exited with code ${code}: ${stderr.substring(0, 200)}`)
            );
            return;
          }

          const translatedMap = this._parseOutput(stdout, startTime);
          resolve(translatedMap);
        });
      });

      child.on('error', (error) => {
        finish(() => {
          this.logger?.error(`${this.displayName} spawn error`, {
            error: error.message,
            elapsed: Date.now() - startTime,
          });
          reject(error);
        });
      });
    });
  }

  _parseOutput(stdout, startTime) {
    try {
      const firstBrace = stdout.indexOf('{');
      const lastBrace = stdout.lastIndexOf('}');
      if (firstBrace === -1 || lastBrace === -1) {
        throw new Error('No JSON object found in output');
      }

      const translatedMap = JSON.parse(stdout.substring(firstBrace, lastBrace + 1));
      this.logger?.debug('Translation completed', {
        client: this.displayName,
        elapsed: Date.now() - startTime,
        keys: Object.keys(translatedMap).length,
      });
      return translatedMap;
    } catch (error) {
      this.logger?.warn('Failed to parse translation JSON', {
        client: this.displayName,
        error: error.message,
        output: stdout.substring(0, 200),
        elapsed: Date.now() - startTime,
      });
      return null;
    }
  }
}
