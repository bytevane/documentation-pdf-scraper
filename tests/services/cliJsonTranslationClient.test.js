import { EventEmitter } from 'events';
import { describe, expect, test, vi } from 'vitest';
import { CliJsonTranslationClient } from '../../src/services/cliJsonTranslationClient.js';

function createHangingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn((signal) => process.nextTick(() => child.emit('close', null, signal)));
  return child;
}

describe('CliJsonTranslationClient', () => {
  test('dispose kills running CLI processes and rejects new work', async () => {
    const child = createHangingChild();
    const client = new CliJsonTranslationClient({ command: 'fake-cli', spawn: () => child });

    const pending = client.translateJson({ instructions: 'x', inputMap: { id: 'text' } });
    client.dispose();

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(pending).rejects.toThrow('exited with code null');
    await expect(client.translateJson({ instructions: 'x', inputMap: {} })).rejects.toThrow(
      'client is disposed'
    );
  });

  test('forgets a process once it has exited', async () => {
    const child = createHangingChild();
    const client = new CliJsonTranslationClient({ command: 'fake-cli', spawn: () => child });

    const pending = client.translateJson({ instructions: 'x', inputMap: { id: 'text' } });
    child.stdout.emit('data', Buffer.from('{"id":"done"}'));
    child.emit('close', 0, null);

    await expect(pending).resolves.toEqual({ id: 'done' });
    expect(client.children.size).toBe(0);
  });
});
