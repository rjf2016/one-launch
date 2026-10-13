import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Puts text on the clipboard with the formats Windows honours to keep it out of clipboard history
 * (Win+V) and cloud clipboard sync: ExcludeClipboardContentFromMonitorProcessing plus the two
 * DWORD-zero flags. Electron's clipboard API cannot add custom formats next to text, so this goes
 * through Windows PowerShell and System.Windows.Forms; the text travels over stdin, never argv.
 */
const SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
  '$text = [Console]::In.ReadToEnd()',
  '$d = New-Object System.Windows.Forms.DataObject',
  '$d.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $text)',
  "foreach ($f in 'ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard') {",
  '  $d.SetData($f, (New-Object System.IO.MemoryStream(,[byte[]](0,0,0,0))))',
  '}',
  '[System.Windows.Forms.Clipboard]::SetDataObject($d, $true)',
].join('; ');

function powershellPath(): string {
  const root = process.env['SystemRoot'] ?? process.env['windir'];
  return root ? join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}

export function writeClipboardPrivately(text: string, timeoutMs = 8_000): Promise<void> {
  if (process.platform !== 'win32') return Promise.reject(new Error('private clipboard writes are Windows-only'));
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('private clipboard write timed out'));
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`private clipboard write failed (exit ${code}): ${stderr.trim().slice(0, 200)}`));
    });
    child.stdin?.end(text, 'utf8');
  });
}
