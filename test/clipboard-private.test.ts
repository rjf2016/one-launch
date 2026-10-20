import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeChild extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly written: { text: string; encoding: string }[] = [];
  killed = false;
  readonly stdin = { end: (text: string, encoding: string) => void this.written.push({ text, encoding }) };
  kill(): void {
    this.killed = true;
  }
}

const spawned: { file: string; args: string[]; opts: { windowsHide?: boolean; stdio?: unknown }; child: FakeChild }[] = [];
vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[], opts: { windowsHide?: boolean; stdio?: unknown }) => {
    const child = new FakeChild();
    spawned.push({ file, args, opts, child });
    return child;
  },
}));

const { writeClipboardPrivately } = await import('../src/main/platform/clipboard-private');

const win = process.platform === 'win32';
const SECRET = 'correct horse battery staple';

beforeEach(() => {
  spawned.length = 0;
});

// node:child_process is imported on the call, so the PowerShell starts a tick later.
const started = (): Promise<void> => vi.waitFor(() => expect(spawned).toHaveLength(1));

describe.skipIf(!win)('private clipboard write (B19)', () => {
  it('hands the text to Windows PowerShell over stdin, never on the command line', async () => {
    const done = writeClipboardPrivately(SECRET);
    await started();
    const { file, args, opts, child } = spawned[0]!;
    expect(file).toMatch(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    expect(args.slice(0, 6)).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command']);
    expect(args.join(' ')).not.toContain(SECRET);
    expect(child.written).toEqual([{ text: SECRET, encoding: 'utf8' }]);
    expect(opts).toMatchObject({ windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    child.emit('close', 0);
    await expect(done).resolves.toBeUndefined();
  });

  it('asks for the three formats that keep the text out of clipboard history and cloud sync, and reads stdin as UTF-8', async () => {
    void writeClipboardPrivately('x').catch(() => undefined);
    await started();
    const script = spawned[0]!.args.at(-1)!;
    for (const format of ['ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard'])
      expect(script).toContain(format);
    expect(script).toContain('[Console]::InputEncoding = [System.Text.Encoding]::UTF8');
    expect(script).toContain('[Console]::In.ReadToEnd()');
    spawned[0]!.child.emit('close', 0);
  });

  it('fails with the exit code and a bounded piece of stderr, which never holds the text', async () => {
    const done = writeClipboardPrivately(SECRET);
    await started();
    const { child } = spawned[0]!;
    child.stderr.emit('data', Buffer.from(`Add-Type : ${'x'.repeat(500)}`, 'utf8'));
    child.emit('close', 1);
    const err = (await done.catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^private clipboard write failed \(exit 1\): Add-Type : x+$/);
    expect(err.message.length).toBeLessThan(260);
    expect(err.message).not.toContain(SECRET);
  });

  it('gives up after the timeout and ends the PowerShell it started', async () => {
    const done = writeClipboardPrivately(SECRET, 20);
    await expect(done).rejects.toThrow('private clipboard write timed out');
    expect(spawned[0]!.child.killed).toBe(true);
  });

  it('reports a PowerShell that could not be started', async () => {
    const done = writeClipboardPrivately(SECRET);
    await started();
    spawned[0]!.child.emit('error', new Error('spawn ENOENT'));
    await expect(done).rejects.toThrow('spawn ENOENT');
  });
});
