import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/main/db';
import { parseLoginUsers } from '../src/main/launchers/steam/loginusers';
import { AccountsService } from '../src/main/services/accounts';
import { FileSink, forgetAccountNames, formatLine, redactAccountNames, redactString, redactValue } from '../src/main/services/logger';

describe('redactString', () => {
  it('redacts key=value credentials in free text', () => {
    expect(redactString('login failed password=hunter2 for user bob')).toBe('login failed password=[REDACTED] for user bob');
    expect(redactString('token: abc123def')).toBe('token: [REDACTED]');
    expect(redactString('"apiKey": "sk-live-123"')).toBe('"apiKey": "[REDACTED]"');
    expect(redactString('api_key=xyz&other=1')).toBe('api_key=[REDACTED]&other=1');
  });

  it('redacts Steam -login command lines', () => {
    expect(redactString('spawn steam.exe -login someuser s3cret!')).toBe('spawn steam.exe -login someuser [REDACTED]');
  });

  it('redacts INI Data= blobs', () => {
    expect(redactString('[RememberMe]\nData=QUJDREVGR0g=')).toBe('[RememberMe]\nData=[REDACTED]');
  });

  it('redacts JWTs and long opaque blobs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redactString(`bearer ${jwt}`)).toBe('bearer [REDACTED]');
    const blob = 'A1b2'.repeat(16);
    expect(redactString(`blob ${blob} end`)).toBe('blob [REDACTED] end');
    // A long run without a digit is a word or a path segment, not a token.
    expect(redactString(`name ${'A'.repeat(64)} end`)).toBe(`name ${'A'.repeat(64)} end`);
  });

  it('redacts email addresses and SteamID64s, including inside error messages', () => {
    expect(redactString('Sign in to it as some.one+tag@example.co.uk, then capture again.')).toBe('Sign in to it as [EMAIL], then capture again.');
    expect(redactString('SteamID64 76561198000000001 is not in loginusers.vdf')).toBe('SteamID64 [STEAMID] is not in loginusers.vdf');
    expect(redactString('appid 252950 and pid 76561198 stay')).toBe('appid 252950 and pid 76561198 stay');
    const line = formatLine('t', 'error', 'x', 'adapter call failed', { error: new Error('The session belongs to a@b.io (76561198000000001)') });
    expect(line).not.toMatch(/a@b\.io|76561198000000001/);
    expect(line).toContain('[EMAIL] ([STEAMID])');
  });

  it('masks the Windows user name in a profile path, raw, JSON-escaped, or with forward slashes, including in an error stack (H5)', () => {
    expect(redactString('data folder C:\\Users\\Jo Smith\\AppData\\Roaming\\OneLaunch')).toBe('data folder C:\\Users\\[USER]\\AppData\\Roaming\\OneLaunch');
    expect(redactString('c:/users/jo/AppData/Local/Temp')).toBe('c:/users/[USER]/AppData/Local/Temp');
    const error = new Error("ENOENT: no such file or directory, open 'C:\\Users\\jo\\AppData\\Roaming\\Battle.net\\Battle.net.config'");
    error.stack = `${error.name}: ${error.message}\n    at readConfig (C:\\Users\\jo\\AppData\\Local\\Programs\\One Launch\\resources\\app.asar\\out\\main\\index.js:10:5)`;
    const line = formatLine('t', 'warn', 'main', 'starting', { dataDir: 'C:\\Users\\jo\\AppData\\Roaming\\OneLaunch', error });
    expect(line).not.toMatch(/users[\\/]+jo\b/i);
    expect(line).toContain('"dataDir":"C:\\\\Users\\\\[USER]\\\\AppData\\\\Roaming\\\\OneLaunch"');
    expect(line).toContain('app.asar\\\\out\\\\main\\\\index.js:10:5');
  });

  it('masks a UUID to its tail, since a Riot account id is one, and leaves ordinary paths and ids alone', () => {
    const line = 'scanned D:\\Games\\Steam\\steamapps\\appmanifest_252950.acf for job 8f3c1a2b-0000-4000-8000-00000000abcd';
    expect(redactString(line)).toBe('scanned D:\\Games\\Steam\\steamapps\\appmanifest_252950.acf for job [UUID…abcd]');
    expect(redactString('account 8f3c1a2b-0000-4000-8000-00000000ABCD done')).toBe('account [UUID…ABCD] done');
    expect(redactString('C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests\\CF741B2C4F0BC4A1B394C7B0AC87A383.item')).toContain(
      'CF741B2C4F0BC4A1B394C7B0AC87A383.item',
    );
  });
});

describe('redactValue', () => {
  it('replaces values under sensitive keys at any depth', () => {
    const out = redactValue({
      login: 'bob',
      password: 'hunter2',
      nested: { apiKey: 'k', secret_enc: Buffer.from('x'), list: [{ token: 't' }] },
    }) as Record<string, unknown>;
    expect(out['login']).toBe('bob');
    expect(out['password']).toBe('[REDACTED]');
    const nested = out['nested'] as Record<string, unknown>;
    expect(nested['apiKey']).toBe('[REDACTED]');
    expect(nested['secret_enc']).toBe('[REDACTED]');
    expect((nested['list'] as Array<Record<string, unknown>>)[0]?.['token']).toBe('[REDACTED]');
  });

  it('summarises buffers and survives cycles and errors', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc['self'] = cyc;
    const out = redactValue(cyc) as Record<string, unknown>;
    expect(out['self']).toBe('[circular]');
    expect(redactValue(Buffer.alloc(10))).toBe('<bytes 10>');
    const err = redactValue(new Error('bad password=abc')) as Record<string, unknown>;
    expect(err['message']).toBe('bad password=[REDACTED]');
  });
});

describe('account names', () => {
  afterEach(() => forgetAccountNames());

  it('masks a name once it has been handed over, in messages, errors, and metadata, whatever its case', () => {
    expect(redactString('Steam rejected the stored password for gordon_f.')).toBe('Steam rejected the stored password for gordon_f.');
    redactAccountNames(['gordon_f', 'Dr. Freeman (main)', null, undefined, '']);
    expect(redactString('Steam rejected the stored password for gordon_f. Update it on the account page.')).toBe(
      'Steam rejected the stored password for [ACCOUNT]. Update it on the account page.',
    );
    expect(redactString('Steam signed in as GORDON_F instead of someone.')).toBe('Steam signed in as [ACCOUNT] instead of someone.');
    const line = formatLine('t', 'error', 'main:ipc', 'handler failed', {
      error: new Error('An account named "Dr. Freeman (main)" already uses this login'),
      reason: 'Before switching to gordon_f',
    });
    expect(line).not.toMatch(/gordon|Freeman/i);
    expect(line).toContain('An account named \\"[ACCOUNT]\\" already uses this login');
  });

  it('matches whole names only and ignores names too short to be safe to mask', () => {
    redactAccountNames(['bob', 'al', 'Main', 'Steam', 'maine']);
    expect(redactString('bobsled and bob and mainWindow and main, al, Steam, Maine')).toBe(
      'bobsled and [ACCOUNT] and mainWindow and main, al, Steam, [ACCOUNT]',
    );
    expect(redactString('D:\\Saves\\bob\\slot1')).toBe('D:\\Saves\\[ACCOUNT]\\slot1');
  });

  it('ignores a name too long to be a login, so a tampered loginusers.vdf cannot break logging (S3)', () => {
    redactAccountNames(['x'.repeat(40_000), 'gordon_f']);
    expect(formatLine('t', 'info', 'x', 'signed in as gordon_f')).toBe('t INFO  [x] signed in as [ACCOUNT]\n');
  });

  it('stays fast on long runs of one kind of character, with names to mask or without (S3)', () => {
    const shapes = ['a', 'A1', 'eyJ', 'a.', 'a@', '@a.', ' ', '\\', '/', 'token ', 'token=', '-login ', 'C:\\', 'Data=', '7656119', 'gordon_'];
    for (const names of [[], ['gordon_f', 'Dr. Freeman (main)']]) {
      redactAccountNames(names);
      for (const shape of shapes) {
        const text = shape.repeat(Math.ceil(100_000 / shape.length));
        const started = performance.now();
        formatLine('t', 'warn', 'x', text, { text });
        expect(performance.now() - started, JSON.stringify(shape)).toBeLessThan(2000);
      }
    }
  });

  it('is fed by the accounts table and by loginusers.vdf, so a name is covered from the moment it is read', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const vault = {
      isAvailable: () => true,
      status: () => ({ available: true, backend: 'dpapi' as const }),
      encrypt: (p: string) => Buffer.from(p),
      decrypt: (c: Buffer) => c.toString(),
    };
    const accounts = new AccountsService(db, { backend: 'dpapi', ...vault });
    accounts.create({ launcher: 'steam', displayName: 'Weekend smurf', login: 'crowbar_77' });
    expect(redactString('switch to crowbar_77 (Weekend smurf) failed')).toBe('switch to [ACCOUNT] ([ACCOUNT]) failed');

    parseLoginUsers('"users"\n{\n\t"76561198000000009"\n\t{\n\t\t"AccountName"\t\t"headcrab_9"\n\t\t"PersonaName"\t\t"Lamarr"\n\t}\n}\n');
    expect(redactString('Steam signed in as headcrab_9 (Lamarr)')).toBe('Steam signed in as [ACCOUNT] ([ACCOUNT])');
    db.close();
  });
});

describe('formatLine', () => {
  it('formats and redacts message and metadata', () => {
    const line = formatLine('2026-09-11T00:00:00.000Z', 'info', 'main', 'hello password=x', { token: 'abc', ok: true });
    expect(line).toBe('2026-09-11T00:00:00.000Z INFO  [main] hello password=[REDACTED] {"token":"[REDACTED]","ok":true}\n');
  });

  it('keeps a message on one line, and clips long text only after redacting it (S3)', () => {
    const forged = formatLine('t', 'warn', 'main:updates', 'bad feed\r\n2026-09-11T00:00:00.000Z ERROR [main] forged');
    expect(forged).toBe('t WARN  [main:updates] bad feed\\r\\n2026-09-11T00:00:00.000Z ERROR [main] forged\n');

    const long = formatLine('t', 'warn', 'x', 'word '.repeat(4000), { stack: 'y'.repeat(20_000) });
    expect(long.length).toBeLessThan(2 * 8192 + 200);
    expect(long.match(/more characters\]/g)).toHaveLength(2);
    expect(long.split('\n')).toHaveLength(2);

    const straddling = formatLine('t', 'warn', 'x', `${'x '.repeat(4090)}${'A1b2'.repeat(16)}`);
    expect(straddling).not.toContain('A1b2');
    expect(straddling).toContain('[REDACTED]');
  });

  it('drops a line it cannot redact instead of writing it as it came', () => {
    expect(formatLine('t', 'info', 'x', undefined as unknown as string, { note: 'kept out too' })).toBe('t INFO  [x] [log line dropped: redaction failed]\n');
  });
});

describe('FileSink', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'onelaunch-log-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes to name.log and rotates when the size limit is exceeded', () => {
    const sink = new FileSink({ dir, name: 'app', maxBytes: 50, keep: 2 });
    const line = 'x'.repeat(19) + '\n'; // 20 bytes
    sink.write(line);
    sink.write(line); // 40
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toBe(line + line);
    sink.write(line); // would be 60 > 50 -> rotate first
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toBe(line);
    expect(readFileSync(join(dir, 'app.1.log'), 'utf8')).toBe(line + line);

    sink.write(line);
    sink.write(line); // rotate again: app.1 -> app.2, app -> app.1
    expect(existsSync(join(dir, 'app.2.log'))).toBe(true);
    sink.write(line);
    sink.write(line); // rotate a third time: oldest (app.2) is dropped, not app.3
    expect(existsSync(join(dir, 'app.3.log'))).toBe(false);
    expect(existsSync(join(dir, 'app.2.log'))).toBe(true);
  });

  it('creates the directory on demand', () => {
    const nested = join(dir, 'a', 'b');
    const sink = new FileSink({ dir: nested, name: 'app', maxBytes: 1000, keep: 1 });
    sink.write('hi\n');
    expect(readFileSync(join(nested, 'app.log'), 'utf8')).toBe('hi\n');
  });
});
