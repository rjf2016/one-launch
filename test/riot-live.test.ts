/**
 * Read-only check against the real Riot Client install on this PC. Skipped unless ONELAUNCH_LIVE=1:
 *
 *     $env:ONELAUNCH_LIVE = '1'; npx vitest run test/riot-live.test.ts --reporter=verbose --silent=false
 *
 * Prints the install, the running state, the health report, the installed products and the session
 * state (whether a sign-in is saved, its fingerprint's first digits and the tail of the account id;
 * never a token or the Riot ID), with the Windows user name masked. It then proves nothing was
 * touched: the session file and the client settings are compared by size and modification time
 * (this test never reads their contents itself), the log folder's file list is unchanged, no backup
 * snapshot exists, and no session was stored. The preflight and the dry-run plan are read-only and
 * are printed as step titles and warnings. launchGame is only asked for an id that is not a product,
 * which it refuses before starting anything: a real launch is the user's (R12). The launch request to
 * the client's local server is a stub that throws, so nothing is ever sent to it from here.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RiotAdapter } from '../src/main/launchers/riot/adapter';
import type { AccountDirectory, AccountRef } from '../src/main/launchers/types';
import { WindowsProcessController } from '../src/main/platform/processes';
import { WindowsRegistry } from '../src/main/platform/registry';
import { migrate, openDatabase } from '../src/main/db';
import { BackupService } from '../src/main/services/backup';
import { createLogger } from '../src/main/services/logger';
import { LauncherSessionStore } from '../src/main/services/sessions';
import type { Vault } from '../src/main/services/vault';
import type { SwitchPlan, VaultStatus } from '../src/shared/models';

const live = process.platform === 'win32' && process.env['ONELAUNCH_LIVE'] === '1';

/** In-memory only: the live check never stores a session or a snapshot. */
class NoVault implements Vault {
  readonly backend = 'dpapi' as const;
  isAvailable(): boolean {
    return false;
  }
  status(): VaultStatus {
    return { available: false, backend: 'none' };
  }
  encrypt(): Buffer {
    throw new Error('the live check never stores a session');
  }
  decrypt(): string {
    throw new Error('the live check never decrypts a session');
  }
}

const mask = (text: string): string => text.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/]+/gi, '$1[USER]');

function fileStamp(path: string): { size: number; mtime: number } | null {
  if (!existsSync(path)) return null;
  const s = statSync(path);
  return { size: s.size, mtime: s.mtimeMs };
}

describe.skipIf(!live)('Riot adapter against the real machine (read-only)', () => {
  it('detects, scans, reads the running state and health-checks without touching anything', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'onelaunch-riot-live-'));
    try {
      const db = openDatabase(':memory:');
      migrate(db);
      const sessions = new LauncherSessionStore(db, new NoVault());
      const backups = new BackupService(join(scratch, 'backups'), { keep: () => 20 });
      const none: AccountDirectory = { byLauncherUid: () => null, byId: () => null, setLauncherUid: () => undefined };
      const adapter = new RiotAdapter({
        pressPlay: () => true,
        localLaunch: {
          launch: async () => {
            throw new Error('the live check never sends the launch request');
          },
        },
        registry: new WindowsRegistry(),
        processes: new WindowsProcessController(),
        backups,
        sessions,
        accounts: none,
        log: createLogger('live:riot'),
        backupsToKeep: () => 20,
      });

      const install = await adapter.detectInstall();
      expect(install).not.toBeNull();
      const logDir = adapter.logDir();
      const before = {
        session: fileStamp(adapter.sessionFilePath()),
        settings: fileStamp(adapter.settingsPath()),
        logs: existsSync(logDir) ? readdirSync(logDir).sort() : [],
      };

      const out: string[] = [];
      out.push(`Install: ${install!.installDir} (${install!.source}), exe ${install!.exePath}`);
      out.push(`Running: ${await adapter.isRunning()}`);
      const game = await adapter.runningGame();
      out.push(`Running game: ${game ? `${game.name} (${game.launcherGameId}, via ${game.source})` : 'none'}`);

      const health = await adapter.healthCheck();
      out.push(`Health: ${health.status}`);
      for (const c of health.checks) out.push(`  [${c.status}] ${c.label}: ${c.detail}`);

      const games = await adapter.listInstalledGames();
      out.push(`Installed games: ${games.length}`);
      for (const g of games) out.push(`  ${g.launcherGameId.padEnd(24)}  ${g.name}  (${g.installPath})  last played ${g.lastPlayedAt ?? '-'}`);
      const remembered = await adapter.listRememberedAccounts();
      out.push(
        `Remembered accounts: ${remembered.length}${remembered.some((r) => r.personaName) ? ' (with a Riot ID as the name suggestion, not printed)' : ''}`,
      );

      const state = await adapter.sessionState();
      out.push(
        `Session state: remembered=${state.remembered} fingerprint=${state.fingerprint?.slice(0, 8) ?? '-'} id=${state.launcherUid ? `…${state.launcherUid.slice(-4)}` : '-'} linked=${state.linkedAccountId ?? '-'} running=${state.launcherRunning}`,
      );
      if (state.remembered) {
        expect(state.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(state.launcherUid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(remembered).toHaveLength(1);
      } else {
        expect(remembered).toEqual([]);
      }

      const account: AccountRef = { id: null, displayName: 'Preview', login: 'someone', launcherUid: null, hasSecret: false };
      // Read-only, like the other launchers' live tests: a game that is running refuses, which is the right answer too.
      let plan: SwitchPlan | null = null;
      try {
        const pf = await adapter.preflight(account);
        plan = pf.plan;
        out.push(`Preflight: running=${pf.launcherRunning} alreadyActive=${pf.alreadyActive}`);
      } catch (err) {
        expect(err).toMatchObject({ code: 'GAME_RUNNING' });
        out.push(`Preflight: refused (${(err as Error).message})`);
      }
      const preview = await adapter.switchAccount(account, { dryRun: true });
      if (plan) expect(preview.steps.map((s) => [s.id, s.skipped])).toEqual(plan.steps.map((s) => [s.id, s.skipped]));
      out.push(`Plan: strategy=${preview.strategy} executable=${preview.executable}`);
      for (const s of preview.steps) out.push(`  [${s.skipped ? 'skip' : 'run '}] ${s.title}`);
      for (const w of preview.warnings) out.push(`  warning: ${w}`);
      for (const [name, code, call] of [
        ['launchGame (not a product id)', null, () => adapter.launchGame({ launcherGameId: 'not-a-product', name: 'Nothing' })],
        ['captureSession (unsaved account)', 'SWITCH_BLOCKED', () => adapter.captureSession(account)],
      ] as const) {
        let err: unknown;
        await call().catch((e: unknown) => {
          err = e;
        });
        expect(err, name).toBeInstanceOf(Error);
        if (code) expect(err, name).toMatchObject({ code });
        out.push(`${name}: refused (${(err as Error).message})`);
      }

      const printed = mask(out.join('\n'));
      console.log(`\n${printed}\n`);

      expect(health.status).not.toBe('fail');
      // Booleans, so a failure never prints the id, the Riot ID, or a token.
      expect(printed.includes('eyJ') || JSON.stringify({ health, games, state, preview }).includes('eyJ')).toBe(false);
      if (state.launcherUid) expect(printed.includes(state.launcherUid)).toBe(false);
      for (const r of remembered) if (r.personaName) expect(printed.includes(r.personaName)).toBe(false);
      expect(fileStamp(adapter.sessionFilePath())).toEqual(before.session);
      expect(fileStamp(adapter.settingsPath())).toEqual(before.settings);
      expect(existsSync(logDir) ? readdirSync(logDir).sort() : []).toEqual(before.logs);
      expect(backups.list('riot')).toEqual([]);
      expect(sessions.list('riot')).toEqual([]);
      db.close();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
