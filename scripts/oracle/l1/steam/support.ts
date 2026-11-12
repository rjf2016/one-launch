import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Case } from '../lib/index';

const SKIPPED = new Set([' ', '\t', '\r', '\n', '﻿']);
const BARE_END = /[\s{}"]/;

// A mirror of the tokenizer in src/main/launchers/steam/vdf.ts: a \s character the tokenizer does not skip, met outside a string or comment, makes it loop forever.
export function vdfTokenizerHangs(text: string): boolean {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i]!;
    if (SKIPPED.has(ch) || ch === '{' || ch === '}') {
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      i++;
      for (;;) {
        if (i >= n) return false;
        const c = text[i]!;
        if (c === '"') {
          i++;
          break;
        }
        if (c === '\\') {
          if (i + 1 >= n) return false;
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }
    let j = i;
    while (j < n && !BARE_END.test(text[j]!)) j++;
    if (j === i) return true;
    i = j;
  }
  return false;
}

const argBytes = (value: unknown): Buffer => (value as { bytes: Buffer }).bytes;

export interface Dropped {
  cases: Case[];
  dropped: string[];
}

export function withoutHangs(cases: Case[], at = 0): Dropped {
  const kept: Case[] = [];
  const dropped: string[] = [];
  for (const item of cases) {
    if (vdfTokenizerHangs(argBytes(item.args[at]).toString('utf8'))) dropped.push(item.id);
    else kept.push(item);
  }
  return { cases: kept, dropped };
}

const USER_FOLDER = /[A-Za-z]:[\\/]{1,4}Users[\\/]{1,4}([^\\/\s"'`*?|:;,)\]\x00-\x1f]+)/gi;

export function withoutUserFolders(cases: Case[], at = 0): Dropped {
  const kept: Case[] = [];
  const dropped: string[] = [];
  for (const item of cases) {
    const names = [...argBytes(item.args[at]).toString('utf8').matchAll(USER_FOLDER)].map((m) => m[1]);
    if (names.some((name) => name !== 'user_1')) dropped.push(item.id);
    else kept.push(item);
  }
  return { cases: kept, dropped };
}

export function userFolderNote(dropped: string[]): string {
  if (dropped.length === 0) return 'No corpus case was dropped for the bundle scan.';
  return `Corpus cases dropped because a mutation turned the fixture's C:\\Users\\user_1 into a user folder name the bundle scan rejects: ${dropped.join(', ')}.`;
}

export function droppedNote(dropped: string[]): string {
  if (dropped.length === 0) return 'No corpus case was dropped.';
  return `Corpus cases dropped because parseVdf never returns on them (a \\s character other than space, tab, CR, LF or U+FEFF outside a string or comment): ${dropped.join(', ')}.`;
}

export function nullProto(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) return value;
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, inner] of Object.entries(value)) out[key] = nullProto(inner);
  return out;
}

export function withFile<T>(name: string, content: Buffer | undefined, run: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'oracle-l1-steam-'));
  try {
    mkdirSync(join(dir, 'logs'));
    const path = join(dir, 'logs', name);
    if (content !== undefined) writeFileSync(path, content);
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const show = (value: string, max = 40): string =>
  `"${[...value.slice(0, max)].map((ch) => (/^[\x20-\x7e]$/.test(ch) && ch !== '"' && ch !== '\\' ? ch : `\\u{${ch.codePointAt(0)!.toString(16)}}`)).join('')}"${value.length > max ? '…' : ''}`;

export const STEAMID = (n: number): string => `765611980000000${String(n).padStart(2, '0')}`;
