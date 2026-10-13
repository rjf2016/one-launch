import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fingerprintOf,
  parseBlob,
  planSignOut,
  readSession,
  riotIdText,
  serializeBlob,
  shortFingerprint,
  spliceSessionBlock,
} from '../src/main/launchers/riot/session';
import { redactString } from '../src/main/services/logger';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'riot', name), 'utf8');
const SIGNED_IN = fixture('RiotGamesPrivateSettings.yaml');
const SIGNED_OUT = fixture('RiotGamesPrivateSettings-signed-out.yaml');
const SUB = '11111111-1111-4111-8111-111111111111';
const REFRESH_TOKEN = /^ {12}refresh_token: "([^"]+)"/m.exec(SIGNED_IN)![1]!;
const ID_TOKEN = /^ {12}id_token: "([^"]+)"/m.exec(SIGNED_IN)![1]!;

function session(text: string) {
  const read = readSession(text);
  if (read.kind !== 'session') throw new Error(`expected a session, got ${read.kind}`);
  return read.session;
}

function unexpectedReason(text: string): string {
  const read = readSession(text);
  if (read.kind !== 'unexpected') throw new Error(`expected a refusal, got ${read.kind}`);
  return read.reason;
}

/** The signed-in fixture with one line of the riot-client block replaced, or dropped when `to` is null. */
function withLine(key: string, to: string | null): string {
  const line = new RegExp(`^ {12}${key}: .*\\r\\n`, 'm');
  expect(SIGNED_IN).toMatch(line);
  return SIGNED_IN.replace(line, to === null ? '' : `            ${key}: ${to}\r\n`);
}

const token = (payload: unknown, middle?: string): string =>
  `${Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url')}.${middle ?? Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig-placeholder`;

describe('Riot session file reader', () => {
  it('reads the account id, the Riot ID and the refresh-token fingerprint from the riot-client block', () => {
    expect(session(SIGNED_IN)).toEqual({
      accountId: SUB,
      riotId: { gameName: 'Placeholder', tagLine: '0000' },
      fingerprint: fingerprintOf(REFRESH_TOKEN),
      dpopBound: false,
      writeCount: 3,
    });
    expect(ID_TOKEN.startsWith('eyJ')).toBe(true);
    expect(REFRESH_TOKEN.length).toBe(1290);
    expect(shortFingerprint(fingerprintOf(REFRESH_TOKEN))).toHaveLength(8);
    expect(riotIdText({ gameName: 'Placeholder', tagLine: '0000' })).toBe('Placeholder#0000');
  });

  it('takes identity from the id token only, never from the leftover riot-login cookies', () => {
    expect(SIGNED_IN).toContain('99999999-9999-4999-8999-999999999999');
    expect(session(SIGNED_IN).accountId).toBe(SUB);
    expect(session(SIGNED_IN.replace(/^ {12}is_dpop_bound: false\r\n[\s\S]*?(?=^ {12}refresh_token: )/m, ''))).toMatchObject({
      accountId: SUB,
      dpopBound: null,
    });
  });

  it('reads the same session through CRLF, LF, a BOM and upper-case ids', () => {
    const expected = session(SIGNED_IN);
    expect(session(SIGNED_IN.replace(/\r\n/g, '\n'))).toEqual(expected);
    expect(session(`${String.fromCharCode(0xfeff)}${SIGNED_IN}`)).toEqual(expected);
    expect(session(withLine('id_token', `"${token({ sub: SUB.toUpperCase(), acct: { game_name: 'Placeholder', tag_line: '0000' } })}"`)).accountId).toBe(SUB);
  });

  it("recognises the client's own signed-out state and nothing else as signed out", () => {
    expect(readSession(SIGNED_OUT)).toEqual({ kind: 'signed-out' });
    expect(readSession(SIGNED_OUT.replace('riot-client: null', 'riot-client: ~'))).toEqual({ kind: 'signed-out' });
    expect(unexpectedReason(SIGNED_OUT.replace('riot-client: null', 'riot-client: "x"'))).toBe('riot-client is neither null nor a block');
    expect(unexpectedReason(SIGNED_OUT.replace('riot-client: null', 'riot-client:'))).toBe('riot-client is empty');
    expect(unexpectedReason(SIGNED_OUT.replace('riot-client: null', 'riot-client: ""'))).toBe('riot-client is neither null nor a block');
  });

  it('fails closed on a file that is not in the shape seen on a real client', () => {
    expect(unexpectedReason('')).toBe('no psl block');
    expect(unexpectedReason('riot-login:\n    persist:\n        region: "NA"\n')).toBe('no psl block');
    expect(unexpectedReason('psl: null\nriot-login:\n    persist:\n')).toBe('no psl.authorization block');
    expect(unexpectedReason('psl:\n    authorization:\n        other: 1\n')).toBe('no psl.authorization.riot-client block');
    expect(unexpectedReason('psl:\n    authorization: {}\n')).toBe('no psl.authorization.riot-client block');
    expect(unexpectedReason(withLine('id_token', null))).toBe('riot-client has no id_token');
    expect(unexpectedReason(withLine('id_token', '""'))).toBe('riot-client has no id_token');
    expect(unexpectedReason(withLine('refresh_token', null))).toBe('riot-client has no refresh_token');
    expect(unexpectedReason(withLine('id_token', '"not-a-token"'))).toBe('id_token is not a readable token');
    expect(unexpectedReason(withLine('id_token', '"a.b"'))).toBe('id_token is not a readable token');
    expect(unexpectedReason(withLine('id_token', `"${token(null, Buffer.from('not json').toString('base64url'))}"`))).toBe('id_token is not a readable token');
    expect(unexpectedReason(withLine('id_token', `"${token([1, 2])}"`))).toBe('id_token is not a readable token');
    expect(unexpectedReason(withLine('id_token', `"${token({ acct: {} })}"`))).toBe('id_token names no account id');
    expect(unexpectedReason(withLine('id_token', `"${token({ sub: 'someone' })}"`))).toBe('id_token names no account id');
    expect(unexpectedReason(withLine('id_token', `"${token({ sub: 12345 })}"`))).toBe('id_token names no account id');
  });

  it('reads only the direct scalars of the block: a deeper id_token or one of another block does not count', () => {
    const nested = withLine('id_token', null).replace(/^ {12}claims: \{\}\r\n/m, `            claims:\r\n                id_token: "${ID_TOKEN}"\r\n`);
    expect(unexpectedReason(nested)).toBe('riot-client has no id_token');
    const elsewhere = withLine('id_token', null).replace(/^riot-login:\r\n/m, `riot-login:\r\n    id_token: "${ID_TOKEN}"\r\n`);
    expect(unexpectedReason(elsewhere)).toBe('riot-client has no id_token');
  });

  it('reports the device-key flag and the write count, and tolerates their absence', () => {
    expect(session(withLine('is_dpop_bound', 'true')).dpopBound).toBe(true);
    expect(session(withLine('is_dpop_bound', null)).dpopBound).toBeNull();
    expect(session(withLine('is_dpop_bound', 'maybe')).dpopBound).toBeNull();
    expect(session(withLine('refresh_token_write_count', '12')).writeCount).toBe(12);
    expect(session(withLine('refresh_token_write_count', null)).writeCount).toBeNull();
    expect(session(withLine('refresh_token_write_count', 'lots')).writeCount).toBeNull();
  });

  it('leaves the Riot ID out when the token has none, and keeps it out of the log when it has one', () => {
    expect(session(withLine('id_token', `"${token({ sub: SUB })}"`)).riotId).toBeNull();
    expect(session(withLine('id_token', `"${token({ sub: SUB, acct: { game_name: 'Only', tag_line: '' } })}"`)).riotId).toBeNull();
    expect(session(withLine('id_token', `"${token({ sub: SUB, acct: { game_name: 'x'.repeat(65), tag_line: 'NA1' } })}"`)).riotId).toBeNull();
    expect(session(withLine('id_token', `"${token({ sub: SUB, acct: { game_name: ' Spaced Name ', tag_line: 'EUW' } })}"`)).riotId).toEqual({
      gameName: 'Spaced Name',
      tagLine: 'EUW',
    });
    session(SIGNED_IN);
    const line = redactString('signed in as Placeholder#0000 (Placeholder)');
    expect(line).not.toContain('Placeholder');
  });

  it('serializes the whole file as the stored blob', () => {
    const json = serializeBlob({ v: 1, file: SIGNED_IN });
    expect(JSON.parse(json)).toEqual({ v: 1, file: SIGNED_IN });
  });
});

describe('Riot session file writes', () => {
  it('signs the file out the way the client does: the block becomes null and every other byte stays', () => {
    const out = planSignOut(SIGNED_IN);
    expect(out.noop).toBe(false);
    expect(out.text).toBe(SIGNED_OUT);
    expect(planSignOut(SIGNED_OUT)).toEqual({ text: SIGNED_OUT, noop: true });
    expect(() => planSignOut('nothing: here\n')).toThrow(/no psl block; the file is left alone/);
  });

  it('splices a block back in at the field indent, keeping the line endings and a BOM, and puts null over a block of any depth', () => {
    const lines = ['id_token: "x.y.z"', 'refresh_token: "r"', 'scopes:', '- "openid"'];
    const spliced = spliceSessionBlock(SIGNED_OUT, lines);
    expect(spliced).toContain(
      '        riot-client:\r\n            id_token: "x.y.z"\r\n            refresh_token: "r"\r\n            scopes:\r\n            - "openid"\r\nriot-login:',
    );
    expect(spliceSessionBlock(spliced, null)).toBe(SIGNED_OUT);
    const lf = `\ufeffpsl:\n    authorization:\n        riot-client:\n            id_token: "a"\n            nested:\n                deep: 1\n\n            refresh_token: "b"\nother: 1\n`;
    expect(spliceSessionBlock(lf, null)).toBe('\ufeffpsl:\n    authorization:\n        riot-client: null\nother: 1\n');
    expect(() => spliceSessionBlock('psl:\n    other: 1\n', null)).toThrow(/no psl\.authorization block/);
  });

  it('reads a stored blob back and refuses anything else', () => {
    expect(parseBlob(serializeBlob({ v: 1, file: SIGNED_IN }))).toEqual({ v: 1, file: SIGNED_IN });
    for (const bad of ['', '{', '[]', 'null', '{"v":2,"file":"x"}', '{"v":1}', '{"v":1,"file":5}']) {
      expect(() => parseBlob(bad)).toThrow(/stored Riot sign-in/);
    }
  });
});
