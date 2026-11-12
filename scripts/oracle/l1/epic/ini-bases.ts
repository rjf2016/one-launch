import { bundleBytes } from '../lib/index';

export const GUS = 'fixtures/launchers/epic/GameUserSettings.ini';
export const FILES_TEST = 'test/epic-files.test.ts';
export const ADAPTER_TEST = 'test/epic-adapter.test.ts';

export const placeholderData = (label: string, length = 40): string => Buffer.from(`placeholder-session-${label}-${'p'.repeat(length)}`).toString('base64');

export const fixtureText = (): string => bundleBytes(GUS).toString('utf8');

export interface Base {
  file: string;
  what: string;
  bytes: Buffer;
}

export function iniBases(): Base[] {
  const original = bundleBytes(GUS);
  const text = original.toString('utf8');
  const remember = `[RememberMe]\r\nEnable=True\r\nData=${placeholderData('small')}\r\n\r\n[Offline]\r\nData=${placeholderData('small-offline', 20)}\r\n`;
  return [
    { file: 'GameUserSettings-lf.ini', what: 'CRLF made LF', bytes: Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8') },
    { file: 'GameUserSettings-bom.ini', what: 'UTF-8 BOM added', bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]) },
    { file: 'GameUserSettings-signed-out.ini', what: 'both Data lines removed', bytes: Buffer.from(text.replace(/^Data=.*\r\n/gm, ''), 'utf8') },
    { file: 'GameUserSettings-small.ini', what: 'only [RememberMe] and [Offline], placeholder Data', bytes: Buffer.from(remember, 'utf8') },
  ];
}
