import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { maskReason as maskBattlenetReason, parseLogEvents as parseBattlenetLog } from '../src/main/launchers/battlenet/client-log';
import { parseProductDb } from '../src/main/launchers/battlenet/products';
import { maskReason as maskEpicReason, parseLogEvents as parseEpicLog } from '../src/main/launchers/epic/launcher-log';
import { MAX_LOG_LINE_LENGTH } from '../src/main/launchers/log-read';
import { MAX_LAUNCHER_FILE_BYTES, MAX_VDF_BYTES, readLauncherBytes, readLauncherText } from '../src/main/launchers/read-file';
import { parseLogEvents as parseRiotLog } from '../src/main/launchers/riot/client-log';
import { readSession } from '../src/main/launchers/riot/session';
import { parseLoginStates } from '../src/main/launchers/steam/login-log';
import { parseLibraryFolders } from '../src/main/launchers/steam/manifests';
import { parseVdf } from '../src/main/launchers/steam/vdf';

function millis(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

describe('launcher files of a size or shape no launcher writes (H16)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onelaunch-limits-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a launcher file only up to a limit, and says so with LAUNCHER_FILE', () => {
    const small = join(dir, 'small.vdf');
    const large = join(dir, 'large.vdf');
    writeFileSync(small, '"users"\n{\n}\n');
    writeFileSync(large, Buffer.alloc(2048, 0x20));
    expect(readLauncherText(small)).toBe('"users"\n{\n}\n');
    expect(readLauncherBytes(large, 2048)).toHaveLength(2048);
    expect(() => readLauncherText(large, 2047)).toThrow(
      expect.objectContaining({ code: 'LAUNCHER_FILE', message: expect.stringMatching(/^Too large to be a launcher file \(2048 bytes\): /) }),
    );
    expect(MAX_VDF_BYTES).toBeLessThan(MAX_LAUNCHER_FILE_BYTES);
  });

  it('refuses VDF blocks nested absurdly deep instead of overflowing the stack', () => {
    const nested = (depth: number): string => `${'"a"\n{\n'.repeat(depth)}${'}\n'.repeat(depth)}`;
    expect(() => parseVdf(nested(20))).not.toThrow();
    expect(() => parseVdf(nested(100_000))).toThrow(/nested too deeply/);
  });

  it('deduplicates twenty thousand library folders without comparing every pair', () => {
    const entries = Array.from({ length: 20_000 }, (_, i) => `\t"${i}"\n\t{\n\t\t"path"\t\t"D:\\\\Lib${i % 10_000}"\n\t}\n`).join('');
    let folders: string[] = [];
    expect(millis(() => (folders = parseLibraryFolders(`"libraryfolders"\n{\n${entries}}\n`)))).toBeLessThan(2000);
    expect(folders).toHaveLength(10_000);
    expect(folders[1]).toBe('D:\\Lib1');
  });

  it('takes a bounded number of products from product.db, each codename once', () => {
    const triple = (i: number): Buffer => Buffer.from(`prod${i}\0tact\0C:\\Games\\P${i}\0`, 'latin1');
    const many = Buffer.concat(Array.from({ length: 5000 }, (_, i) => triple(i % 4000)));
    const products = parseProductDb(many);
    expect(products).toHaveLength(512);
    expect(new Set(products.map((p) => p.codename)).size).toBe(512);
    expect(parseProductDb(Buffer.concat([triple(1), triple(1), triple(2)])).map((p) => p.codename)).toEqual(['prod1', 'prod2']);
  });

  it('masks a failure reason in linear time, whatever one long run of characters it holds', () => {
    expect(maskBattlenetReason('wrong password for some.one@example.com token 0123456789abcdef0123')).toBe('wrong password for … token …');
    expect(millis(() => maskBattlenetReason('a'.repeat(200_000)))).toBeLessThan(1000);
    expect(millis(() => maskBattlenetReason('a.'.repeat(100_000)))).toBeLessThan(1000);
    expect(millis(() => maskBattlenetReason('a@'.repeat(100_000)))).toBeLessThan(1000);

    expect(maskEpicReason('errormessage=x 0123456789abcdef0123456789abcdef y   errorpath=z errorpath=again')).toBe('x … y');
    expect(maskEpicReason('errormessage=no path here ')).toBe('no path here');
    expect(millis(() => maskEpicReason(' '.repeat(200_000)))).toBeLessThan(1000);
  });

  it('skips a log line longer than any launcher writes and still reads the lines around it', () => {
    const long = 'x'.repeat(MAX_LOG_LINE_LENGTH + 1);

    const battlenet = parseBattlenetLog(
      [
        `I 2026-09-13 03:20:55.149702 [BNLogin] {Main} Login failed. error=${long}`,
        'I 2026-09-13 03:20:56.000000 [BNLogin] {Main} Login failed. error=bad password',
      ].join('\r\n'),
    );
    expect(battlenet).toEqual([{ kind: 'sign-in-failed', reason: 'bad password' }]);

    const epic = parseEpicLog(
      [
        `[2026.09.13-00.09.05:354][713]LogAccount: FAccountService::OnLoginComplete - 0 FALSE ${long}`,
        '[2026.09.13-00.09.06:000][714]LogAccount: FAccountService::OnLoginComplete - 0 FALSE errormessage=expired errorpath=x',
      ].join('\r\n'),
    );
    expect(epic).toEqual([{ kind: 'sign-in-failed', reason: 'expired' }]);

    const steam = parseLoginStates([`SetLoginState: WaitingForCredentials - ${long}`, 'SetLoginState: Success - OK'].join('\n'));
    expect(steam).toEqual([{ state: 'Success', reason: 'OK' }]);

    const riot = parseRiotLog(
      [
        `000001.000| ALWAYS| riot-client-lifecycle: PSLProvider: PSL state changed to ${long}`,
        '000001.001| ALWAYS| riot-client-lifecycle: PSLProvider: PSL state changed to PendingLoginStrategy',
      ].join('\r\n'),
    );
    expect(riot).toEqual([{ kind: 'psl-state', state: 'PendingLoginStrategy' }]);
  });

  it('reads a Riot session file in linear time, whatever one long line or a deep pile of lines holds', () => {
    const token = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"11111111-1111-4111-8111-111111111111"}').toString('base64url')}.sig`;
    const block = (refresh: string, extra = ''): string =>
      `psl:\n    authorization:\n        riot-client:\n            id_token: "${token}"\n            refresh_token: "${refresh}"\n${extra}`;
    let read = readSession('');
    expect(millis(() => (read = readSession(block('r'.repeat(1_000_000)))))).toBeLessThan(1000);
    expect(read.kind).toBe('session');
    expect(millis(() => (read = readSession(block('short', `${' '.repeat(200_000)}\n${'a'.repeat(200_000)}\n${'-'.repeat(200_000)}: x\n`))))).toBeLessThan(
      1000,
    );
    expect(read.kind).toBe('session');
    expect(millis(() => (read = readSession(`${'key: value\n'.repeat(100_000)}${block('short')}`)))).toBeLessThan(1000);
    expect(read.kind).toBe('session');
    expect(millis(() => (read = readSession(`psl:\n    authorization:\n        riot-client:\n${'            nested:\n'.repeat(100_000)}`)))).toBeLessThan(1000);
    expect(read).toEqual({ kind: 'unexpected', reason: 'riot-client has no id_token' });
  });
});
